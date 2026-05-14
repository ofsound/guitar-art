use std::collections::VecDeque;
use std::f32::consts::PI;
use std::sync::{
    atomic::{AtomicBool, AtomicU32, Ordering},
    Arc, Mutex,
};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use napi::bindgen_prelude::*;
use napi_derive::napi;
use rtrb::{Consumer, Producer, RingBuffer};
use rustfft::{num_complex::Complex, FftPlanner};

const FFT_SIZE: usize = 4096;
const SAMPLE_QUEUE_CAPACITY: usize = 48_000;
const CHROMA_BINS: usize = 12;
const LOG_SPECTRUM_BINS: usize = 36;
const GUITAR_TUNING: [(u32, i32); 6] = [
    (6, 40), // E2
    (5, 45), // A2
    (4, 50), // D3
    (3, 55), // G3
    (2, 59), // B3
    (1, 64), // E4
];
const NOTE_NAMES: [&str; CHROMA_BINS] = [
    "C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B",
];

#[napi(object)]
#[derive(Clone, Debug)]
pub struct AudioDevice {
    pub id: String,
    pub name: String,
    pub host: String,
    pub input_channels: u32,
    pub default_sample_rate: u32,
    pub supported_sample_rates: Vec<u32>,
    pub is_default: bool,
}

#[napi(object)]
#[derive(Clone, Debug)]
pub struct AudioStartConfig {
    pub mode: String,
    pub device_id: Option<String>,
    pub channel_index: u32,
    pub sample_rate: u32,
    pub buffer_size: u32,
    pub feature_rate_hz: u32,
    pub input_gain: f64,
    pub gate_threshold: f64,
}

#[napi(object)]
#[derive(Clone, Debug)]
pub struct AudioParamsUpdate {
    pub input_gain: Option<f64>,
    pub gate_threshold: Option<f64>,
}

#[napi(object)]
#[derive(Clone, Debug)]
pub struct RawAudioRecording {
    pub sample_rate: u32,
    pub samples: Vec<f64>,
}

#[napi(object)]
#[derive(Clone, Debug)]
pub struct AnalysisRecordingWaveform {
    pub duration_ms: f64,
    pub total_samples: u32,
    pub waveform: Vec<f64>,
}

#[napi(object)]
#[derive(Clone, Debug)]
pub struct GuitarVoicingCandidate {
    pub string_number: u32,
    pub fret_number: u32,
    pub pitch_class: u32,
    pub confidence: f64,
}

#[napi(object)]
#[derive(Clone, Debug)]
pub struct GuitarEvent {
    pub id: u32,
    pub t: f64,
    pub r#type: String,
    pub strength: f64,
    pub note_name: Option<String>,
    pub pitch_hz: Option<f64>,
    pub string_number: Option<u32>,
    pub fret_number: Option<u32>,
    pub chord_name: Option<String>,
}

#[napi(object)]
#[derive(Clone, Debug)]
pub struct AudioFeatures {
    pub t: f64,
    pub rms: f64,
    pub peak: f64,
    pub low: f64,
    pub mid: f64,
    pub high: f64,
    pub spectral_centroid: f64,
    pub pitch_hz: Option<f64>,
    pub pitch_confidence: f64,
    pub note_name: Option<String>,
    pub note_stability: f64,
    pub onset: f64,
    pub gate: bool,
    pub clipping: bool,
    pub chroma: Vec<f64>,
    pub spectral_flux: f64,
    pub spectral_rolloff: f64,
    pub spectral_flatness: f64,
    pub zero_crossing_rate: f64,
    pub brightness: f64,
    pub noisiness: f64,
    pub attack: f64,
    pub decay: f64,
    pub bend_cents: f64,
    pub vibrato_depth: f64,
    pub vibrato_rate: f64,
    pub harmonic_density: f64,
    pub chord_root: Option<String>,
    pub chord_quality: Option<String>,
    pub chord_name: Option<String>,
    pub chord_confidence: f64,
    pub log_spectrum: Vec<f64>,
    pub spectral_contrast: f64,
    pub harmonic_ratio: f64,
    pub pick_noise: f64,
    pub mute_amount: f64,
    pub guitar_technique: String,
    pub guitar_technique_confidence: f64,
    pub string_number: Option<u32>,
    pub fret_number: Option<u32>,
    pub voicing: Vec<GuitarVoicingCandidate>,
    pub guitar_events: Vec<GuitarEvent>,
}

impl Default for AudioFeatures {
    fn default() -> Self {
        Self {
            t: 0.0,
            rms: 0.0,
            peak: 0.0,
            low: 0.0,
            mid: 0.0,
            high: 0.0,
            spectral_centroid: 0.0,
            pitch_hz: None,
            pitch_confidence: 0.0,
            note_name: None,
            note_stability: 0.0,
            onset: 0.0,
            gate: false,
            clipping: false,
            chroma: vec![0.0; CHROMA_BINS],
            spectral_flux: 0.0,
            spectral_rolloff: 0.0,
            spectral_flatness: 0.0,
            zero_crossing_rate: 0.0,
            brightness: 0.0,
            noisiness: 0.0,
            attack: 0.0,
            decay: 0.0,
            bend_cents: 0.0,
            vibrato_depth: 0.0,
            vibrato_rate: 0.0,
            harmonic_density: 0.0,
            chord_root: None,
            chord_quality: None,
            chord_name: None,
            chord_confidence: 0.0,
            log_spectrum: vec![0.0; LOG_SPECTRUM_BINS],
            spectral_contrast: 0.0,
            harmonic_ratio: 0.0,
            pick_noise: 0.0,
            mute_amount: 0.0,
            guitar_technique: "idle".to_string(),
            guitar_technique_confidence: 0.0,
            string_number: None,
            fret_number: None,
            voicing: Vec::new(),
            guitar_events: Vec::new(),
        }
    }
}

struct RunningEngine {
    stop: Arc<AtomicBool>,
    stream: Option<cpal::Stream>,
    dsp_thread: Option<JoinHandle<()>>,
}

struct RawAnalysisRecording {
    stream: Option<cpal::Stream>,
    samples: Arc<Mutex<Vec<f32>>>,
    sample_rate: u32,
    started_at: Instant,
}

struct LiveAudioParams {
    input_gain_bits: AtomicU32,
    gate_threshold_bits: AtomicU32,
}

struct GuitarAnalyzerState {
    next_event_id: u32,
    last_gate: bool,
    last_chord_name: Option<String>,
    last_pitch_hz: Option<f32>,
    last_onset_t: f64,
    events: VecDeque<GuitarEvent>,
}

impl GuitarAnalyzerState {
    fn new() -> Self {
        Self {
            next_event_id: 1,
            last_gate: false,
            last_chord_name: None,
            last_pitch_hz: None,
            last_onset_t: -10.0,
            events: VecDeque::with_capacity(48),
        }
    }

    fn update(&mut self, features: &mut AudioFeatures, now_secs: f64) {
        let strength = features.onset.max(features.rms).clamp(0.0, 1.0);
        let note_name = features.note_name.clone();
        let pitch_hz = features.pitch_hz;
        let string_number = features.string_number;
        let fret_number = features.fret_number;

        if features.gate && !self.last_gate {
            self.push_event(
                now_secs,
                "note_on",
                strength,
                note_name.clone(),
                pitch_hz,
                string_number,
                fret_number,
                features.chord_name.clone(),
            );
        } else if !features.gate && self.last_gate {
            self.push_event(now_secs, "note_off", 0.4, None, None, None, None, None);
        }

        if features.onset > 0.34 && now_secs - self.last_onset_t > 0.055 {
            let event_type = if features.chord_confidence > 0.42 || features.harmonic_density > 0.5 {
                "strum"
            } else {
                "pluck"
            };
            self.push_event(
                now_secs,
                event_type,
                features.onset,
                note_name.clone(),
                pitch_hz,
                string_number,
                fret_number,
                features.chord_name.clone(),
            );
            self.last_onset_t = now_secs;
        }

        if features.mute_amount > 0.58 && features.gate {
            self.push_event(
                now_secs,
                "mute",
                features.mute_amount,
                note_name.clone(),
                pitch_hz,
                string_number,
                fret_number,
                features.chord_name.clone(),
            );
        }

        if features.pick_noise > 0.62 && features.gate {
            self.push_event(
                now_secs,
                "noise",
                features.pick_noise,
                note_name.clone(),
                pitch_hz,
                string_number,
                fret_number,
                features.chord_name.clone(),
            );
        }

        if features.vibrato_depth > 0.18 && features.vibrato_rate > 0.16 {
            self.push_event(
                now_secs,
                "vibrato",
                features.vibrato_depth.max(features.vibrato_rate),
                note_name.clone(),
                pitch_hz,
                string_number,
                fret_number,
                None,
            );
        } else if features.bend_cents.abs() > 45.0 && features.pitch_confidence > 0.4 {
            self.push_event(
                now_secs,
                "bend",
                (features.bend_cents.abs() / 160.0).clamp(0.0, 1.0),
                note_name.clone(),
                pitch_hz,
                string_number,
                fret_number,
                None,
            );
        }

        if features.chord_name != self.last_chord_name && features.chord_confidence > 0.5 {
            self.push_event(
                now_secs,
                "chord_change",
                features.chord_confidence,
                None,
                None,
                None,
                None,
                features.chord_name.clone(),
            );
        }

        self.last_gate = features.gate;
        self.last_chord_name = features.chord_name.clone();
        self.last_pitch_hz = features.pitch_hz.map(|pitch| pitch as f32);
        self.expire(now_secs);
        features.guitar_events = self.events.iter().cloned().collect();
    }

    fn push_event(
        &mut self,
        t: f64,
        event_type: &str,
        strength: f64,
        note_name: Option<String>,
        pitch_hz: Option<f64>,
        string_number: Option<u32>,
        fret_number: Option<u32>,
        chord_name: Option<String>,
    ) {
        if let Some(last) = self.events.back() {
            if last.r#type == event_type && t - last.t < 0.08 {
                return;
            }
        }

        self.events.push_back(GuitarEvent {
            id: self.next_event_id,
            t,
            r#type: event_type.to_string(),
            strength: strength.clamp(0.0, 1.0),
            note_name,
            pitch_hz,
            string_number,
            fret_number,
            chord_name,
        });
        self.next_event_id = self.next_event_id.wrapping_add(1).max(1);
        while self.events.len() > 32 {
            self.events.pop_front();
        }
    }

    fn expire(&mut self, now_secs: f64) {
        while let Some(event) = self.events.front() {
            if now_secs - event.t <= 1.5 {
                break;
            }
            self.events.pop_front();
        }
    }
}

impl LiveAudioParams {
    fn new(input_gain: f32, gate_threshold: f32) -> Self {
        Self {
            input_gain_bits: AtomicU32::new(input_gain.to_bits()),
            gate_threshold_bits: AtomicU32::new(gate_threshold.to_bits()),
        }
    }

    fn set(&self, update: &AudioParamsUpdate) {
        if let Some(input_gain) = valid_param(update.input_gain) {
            self.input_gain_bits
                .store(input_gain.to_bits(), Ordering::Relaxed);
        }

        if let Some(gate_threshold) = valid_param(update.gate_threshold) {
            self.gate_threshold_bits
                .store(gate_threshold.to_bits(), Ordering::Relaxed);
        }
    }

    fn input_gain(&self) -> f32 {
        f32::from_bits(self.input_gain_bits.load(Ordering::Relaxed))
    }

    fn gate_threshold(&self) -> f32 {
        f32::from_bits(self.gate_threshold_bits.load(Ordering::Relaxed))
    }
}

#[napi]
pub struct AudioEngine {
    latest: Arc<Mutex<AudioFeatures>>,
    params: Arc<LiveAudioParams>,
    running: Option<RunningEngine>,
    analysis_recording: Option<RawAnalysisRecording>,
    mode: String,
}

#[napi]
impl AudioEngine {
    #[napi(constructor)]
    pub fn new() -> Self {
        Self {
            latest: Arc::new(Mutex::new(AudioFeatures::default())),
            params: Arc::new(LiveAudioParams::new(1.0, 0.025)),
            running: None,
            analysis_recording: None,
            mode: "live".to_string(),
        }
    }

    #[napi(js_name = "listDevices")]
    pub fn list_devices(&self) -> Result<Vec<AudioDevice>> {
        list_devices().map_err(|error| Error::from_reason(error.to_string()))
    }

    #[napi]
    pub fn start(&mut self, config: AudioStartConfig) -> Result<()> {
        self.stop();
        self.mode = config.mode.clone();
        self.params.set(&AudioParamsUpdate {
            input_gain: Some(config.input_gain),
            gate_threshold: Some(config.gate_threshold),
        });

        if config.mode != "live" {
            return Ok(());
        }

        let host = cpal::default_host();
        let device = select_device(&host, config.device_id.as_deref())
            .map_err(|error| Error::from_reason(error.to_string()))?;
        let supported = device
            .default_input_config()
            .map_err(|error| Error::from_reason(format!("No default input config: {error}")))?;
        let sample_format = supported.sample_format();
        let channels = supported.channels();
        let stream_config = cpal::StreamConfig {
            channels,
            sample_rate: cpal::SampleRate(config.sample_rate),
            buffer_size: cpal::BufferSize::Fixed(config.buffer_size),
        };

        let (producer, consumer) = RingBuffer::<f32>::new(SAMPLE_QUEUE_CAPACITY);
        let stop = Arc::new(AtomicBool::new(false));
        let latest = self.latest.clone();
        let params = self.params.clone();
        let dsp_stop = stop.clone();
        let dsp_config = config.clone();
        let dsp_params = params.clone();
        let dsp_thread = thread::spawn(move || {
            run_dsp(consumer, latest, dsp_stop, dsp_config, dsp_params);
        });

        let channel_index = if config.channel_index < channels as u32 {
            Some(config.channel_index as usize)
        } else {
            None
        };
        let err_fn = |error| eprintln!("CPAL stream error: {error}");
        let stream = match sample_format {
            cpal::SampleFormat::F32 => build_input_stream::<f32>(
                &device,
                &stream_config,
                channels as usize,
                channel_index,
                params.clone(),
                producer,
                err_fn,
            ),
            cpal::SampleFormat::I16 => build_input_stream::<i16>(
                &device,
                &stream_config,
                channels as usize,
                channel_index,
                params.clone(),
                producer,
                err_fn,
            ),
            cpal::SampleFormat::U16 => build_input_stream::<u16>(
                &device,
                &stream_config,
                channels as usize,
                channel_index,
                params.clone(),
                producer,
                err_fn,
            ),
            _ => Err(cpal::BuildStreamError::StreamConfigNotSupported),
        }
        .map_err(|error| Error::from_reason(format!("Unable to build input stream: {error}")))?;

        stream.play().map_err(|error| {
            Error::from_reason(format!("Unable to start input stream: {error}"))
        })?;

        self.running = Some(RunningEngine {
            stop,
            stream: Some(stream),
            dsp_thread: Some(dsp_thread),
        });
        Ok(())
    }

    #[napi]
    pub fn stop(&mut self) {
        if let Some(mut running) = self.running.take() {
            running.stop.store(true, Ordering::SeqCst);
            drop(running.stream.take());
            if let Some(handle) = running.dsp_thread.take() {
                let _ = handle.join();
            }
        }
    }

    #[napi(js_name = "setMode")]
    pub fn set_mode(&mut self, mode: String) {
        self.mode = mode;
    }

    #[napi(js_name = "setParams")]
    pub fn set_params(&mut self, params: AudioParamsUpdate) {
        self.params.set(&params);
    }

    #[napi(js_name = "getLatestFeatures")]
    pub fn get_latest_features(&self) -> AudioFeatures {
        self.latest.lock().unwrap().clone()
    }

    #[napi(js_name = "startAnalysisRecording")]
    pub fn start_analysis_recording(&mut self, config: AudioStartConfig) -> Result<()> {
        let _ = self.stop_analysis_recording_internal();

        let host = cpal::default_host();
        let device = select_device(&host, config.device_id.as_deref())
            .map_err(|error| Error::from_reason(error.to_string()))?;
        let supported = device
            .default_input_config()
            .map_err(|error| Error::from_reason(format!("No default input config: {error}")))?;
        let sample_format = supported.sample_format();
        let channels = supported.channels();
        let stream_config = cpal::StreamConfig {
            channels,
            sample_rate: cpal::SampleRate(config.sample_rate),
            buffer_size: cpal::BufferSize::Fixed(config.buffer_size),
        };
        let channel_index = if config.channel_index < channels as u32 {
            Some(config.channel_index as usize)
        } else {
            None
        };
        let samples = Arc::new(Mutex::new(Vec::<f32>::with_capacity(config.sample_rate as usize * 20)));
        let err_fn = |error| eprintln!("CPAL analysis stream error: {error}");
        let input_gain = config.input_gain as f32;
        let stream = match sample_format {
            cpal::SampleFormat::F32 => build_recording_stream::<f32>(
                &device,
                &stream_config,
                channels as usize,
                channel_index,
                input_gain,
                samples.clone(),
                err_fn,
            ),
            cpal::SampleFormat::I16 => build_recording_stream::<i16>(
                &device,
                &stream_config,
                channels as usize,
                channel_index,
                input_gain,
                samples.clone(),
                err_fn,
            ),
            cpal::SampleFormat::U16 => build_recording_stream::<u16>(
                &device,
                &stream_config,
                channels as usize,
                channel_index,
                input_gain,
                samples.clone(),
                err_fn,
            ),
            _ => Err(cpal::BuildStreamError::StreamConfigNotSupported),
        }
        .map_err(|error| Error::from_reason(format!("Unable to build analysis input stream: {error}")))?;

        stream.play().map_err(|error| {
            Error::from_reason(format!("Unable to start analysis input stream: {error}"))
        })?;

        self.analysis_recording = Some(RawAnalysisRecording {
            stream: Some(stream),
            samples,
            sample_rate: config.sample_rate,
            started_at: Instant::now(),
        });
        Ok(())
    }

    #[napi(js_name = "getAnalysisRecordingWaveform")]
    pub fn get_analysis_recording_waveform(&self) -> AnalysisRecordingWaveform {
        let Some(recording) = self.analysis_recording.as_ref() else {
            return AnalysisRecordingWaveform {
                duration_ms: 0.0,
                total_samples: 0,
                waveform: Vec::new(),
            };
        };
        let samples = recording.samples.lock().unwrap();
        let recent_len = (recording.sample_rate as usize * 4).min(samples.len());
        let start = samples.len().saturating_sub(recent_len);
        AnalysisRecordingWaveform {
            duration_ms: recording.started_at.elapsed().as_secs_f64() * 1000.0,
            total_samples: samples.len().min(u32::MAX as usize) as u32,
            waveform: waveform_peaks(&samples[start..], 180),
        }
    }

    #[napi(js_name = "stopAnalysisRecording")]
    pub fn stop_analysis_recording(&mut self) -> RawAudioRecording {
        self.stop_analysis_recording_internal().unwrap_or(RawAudioRecording {
            sample_rate: 48_000,
            samples: Vec::new(),
        })
    }
}

impl Drop for AudioEngine {
    fn drop(&mut self) {
        self.stop();
        let _ = self.stop_analysis_recording_internal();
    }
}

impl AudioEngine {
    fn stop_analysis_recording_internal(&mut self) -> Option<RawAudioRecording> {
        let mut recording = self.analysis_recording.take()?;
        drop(recording.stream.take());
        let samples = recording
            .samples
            .lock()
            .unwrap()
            .iter()
            .map(|sample| *sample as f64)
            .collect::<Vec<_>>();
        Some(RawAudioRecording {
            sample_rate: recording.sample_rate,
            samples,
        })
    }
}

fn list_devices() -> std::result::Result<Vec<AudioDevice>, Box<dyn std::error::Error>> {
    let host = cpal::default_host();
    let default_name = host
        .default_input_device()
        .and_then(|device| device.name().ok());
    let mut devices = Vec::new();

    for (index, device) in host.input_devices()?.enumerate() {
        let name = device.name().unwrap_or_else(|_| format!("Input {index}"));
        let default_config = device.default_input_config().ok();
        let mut supported_sample_rates = Vec::new();
        let mut input_channels = default_config
            .as_ref()
            .map(|config| config.channels())
            .unwrap_or(1) as u32;
        let mut default_sample_rate = default_config
            .as_ref()
            .map(|config| config.sample_rate().0)
            .unwrap_or(48_000);

        if let Ok(configs) = device.supported_input_configs() {
            for config in configs {
                input_channels = input_channels.max(config.channels() as u32);
                supported_sample_rates.push(config.min_sample_rate().0);
                supported_sample_rates.push(config.max_sample_rate().0);
                if config.min_sample_rate().0 <= 48_000 && config.max_sample_rate().0 >= 48_000 {
                    default_sample_rate = 48_000;
                }
            }
        }
        supported_sample_rates.sort_unstable();
        supported_sample_rates.dedup();

        devices.push(AudioDevice {
            id: index.to_string(),
            name: name.clone(),
            host: format!("{:?}", host.id()),
            input_channels,
            default_sample_rate,
            supported_sample_rates,
            is_default: default_name.as_ref() == Some(&name),
        });
    }

    Ok(devices)
}

fn select_device(
    host: &cpal::Host,
    id: Option<&str>,
) -> std::result::Result<cpal::Device, Box<dyn std::error::Error>> {
    if let Some(id) = id {
        if let Ok(index) = id.parse::<usize>() {
            if let Some(device) = host.input_devices()?.nth(index) {
                return Ok(device);
            }
        }
    }

    host.default_input_device()
        .ok_or_else(|| "No default input device available".into())
}

fn valid_param(value: Option<f64>) -> Option<f32> {
    value
        .filter(|value| value.is_finite() && *value >= 0.0)
        .map(|value| value as f32)
}

fn build_input_stream<T>(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    channels: usize,
    channel_index: Option<usize>,
    params: Arc<LiveAudioParams>,
    mut producer: Producer<f32>,
    err_fn: impl FnMut(cpal::StreamError) + Send + 'static,
) -> std::result::Result<cpal::Stream, cpal::BuildStreamError>
where
    T: cpal::Sample + cpal::SizedSample,
    f32: cpal::FromSample<T>,
{
    device.build_input_stream(
        config,
        move |data: &[T], _| {
            let input_gain = params.input_gain();
            for frame in data.chunks(channels) {
                let sample = channel_index
                    .and_then(|index| frame.get(index))
                    .or_else(|| {
                        frame.iter().max_by(|a, b| {
                            let a = a.to_sample::<f32>().abs();
                            let b = b.to_sample::<f32>().abs();
                            a.partial_cmp(&b).unwrap_or(std::cmp::Ordering::Equal)
                        })
                    });
                if let Some(sample) = sample {
                    let _ = producer.push(sample.to_sample::<f32>() * input_gain);
                }
            }
        },
        err_fn,
        None,
    )
}

fn build_recording_stream<T>(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    channels: usize,
    channel_index: Option<usize>,
    input_gain: f32,
    samples: Arc<Mutex<Vec<f32>>>,
    err_fn: impl FnMut(cpal::StreamError) + Send + 'static,
) -> std::result::Result<cpal::Stream, cpal::BuildStreamError>
where
    T: cpal::Sample + cpal::SizedSample,
    f32: cpal::FromSample<T>,
{
    device.build_input_stream(
        config,
        move |data: &[T], _| {
            if let Ok(mut recorded) = samples.lock() {
                recorded.reserve(data.len() / channels);
                for frame in data.chunks(channels) {
                    let sample = channel_index
                        .and_then(|index| frame.get(index))
                        .or_else(|| {
                            frame.iter().max_by(|a, b| {
                                let a = a.to_sample::<f32>().abs();
                                let b = b.to_sample::<f32>().abs();
                                a.partial_cmp(&b).unwrap_or(std::cmp::Ordering::Equal)
                            })
                        });
                    if let Some(sample) = sample {
                        recorded.push(sample.to_sample::<f32>() * input_gain);
                    }
                }
            }
        },
        err_fn,
        None,
    )
}

fn waveform_peaks(samples: &[f32], point_count: usize) -> Vec<f64> {
    if samples.is_empty() {
        return Vec::new();
    }
    let bucket_size = (samples.len() / point_count.max(1)).max(1);
    let mut waveform = Vec::with_capacity(point_count);
    for chunk in samples.chunks(bucket_size).take(point_count) {
        let peak = chunk
            .iter()
            .fold(0.0_f32, |acc, sample| acc.max(sample.abs()))
            .clamp(0.0, 1.0);
        waveform.push(peak as f64);
    }
    waveform
}

fn run_dsp(
    mut consumer: Consumer<f32>,
    latest: Arc<Mutex<AudioFeatures>>,
    stop: Arc<AtomicBool>,
    config: AudioStartConfig,
    params: Arc<LiveAudioParams>,
) {
    let sample_rate = config.sample_rate as f32;
    let feature_interval = Duration::from_secs_f64(1.0 / config.feature_rate_hz.max(1) as f64);
    let mut window = VecDeque::<f32>::with_capacity(FFT_SIZE);
    let mut last_publish = Instant::now();
    let started = Instant::now();
    let mut last_rms = 0.0_f32;
    let mut stable_pitch = None::<f32>;
    let mut note_stability = 0.0_f32;
    let mut previous_magnitudes = vec![0.0_f32; FFT_SIZE / 2];
    let mut pitch_history = VecDeque::<(f64, f32)>::with_capacity(80);
    let mut guitar_state = GuitarAnalyzerState::new();
    let mut planner = FftPlanner::<f32>::new();
    let fft = planner.plan_fft_forward(FFT_SIZE);
    let mut fft_buffer = vec![Complex::new(0.0, 0.0); FFT_SIZE];

    while !stop.load(Ordering::Relaxed) {
        while let Ok(sample) = consumer.pop() {
            if window.len() == FFT_SIZE {
                window.pop_front();
            }
            window.push_back(sample);
        }

        if window.len() == FFT_SIZE && last_publish.elapsed() >= feature_interval {
            let samples = window.make_contiguous();
            let elapsed = started.elapsed().as_secs_f64();
            let mut features = analyze_window(
                samples,
                sample_rate,
                params.gate_threshold(),
                last_rms,
                stable_pitch,
                note_stability,
                elapsed,
                &mut previous_magnitudes,
                &mut pitch_history,
                &mut guitar_state,
                &fft,
                &mut fft_buffer,
            );
            features.t = elapsed;
            last_rms = rms(samples);
            stable_pitch = features.pitch_hz.map(|pitch| pitch as f32);
            note_stability = features.note_stability as f32;
            *latest.lock().unwrap() = features;
            last_publish = Instant::now();
        }

        thread::sleep(Duration::from_millis(1));
    }
}

fn analyze_window(
    samples: &[f32],
    sample_rate: f32,
    gate_threshold: f32,
    previous_rms: f32,
    previous_pitch: Option<f32>,
    previous_stability: f32,
    now_secs: f64,
    previous_magnitudes: &mut [f32],
    pitch_history: &mut VecDeque<(f64, f32)>,
    guitar_state: &mut GuitarAnalyzerState,
    fft: &Arc<dyn rustfft::Fft<f32>>,
    fft_buffer: &mut [Complex<f32>],
) -> AudioFeatures {
    let rms = rms(samples);
    let peak = peak(samples);
    let clipping = peak > 0.98;
    let gate = rms > gate_threshold;
    let spectral = spectral_features(samples, sample_rate, fft, fft_buffer);
    let spectral_flux = spectral_flux(&spectral.magnitudes, previous_magnitudes);
    previous_magnitudes.copy_from_slice(&spectral.magnitudes);
    let rms_onset = ((rms - previous_rms).max(0.0) * 8.0).clamp(0.0, 1.0);
    let onset = rms_onset.max(spectral_flux);
    let attack = ((rms - previous_rms).max(0.0) * 10.0 + spectral_flux * 0.7).clamp(0.0, 1.0);
    let decay = ((previous_rms - rms).max(0.0) * 7.0).clamp(0.0, 1.0);
    let zero_crossing_rate = zero_crossing_rate(samples);
    let (pitch_hz, confidence) = detect_pitch_mpm(samples, sample_rate);
    let pitch_hz = if gate && confidence > 0.22 {
        pitch_hz
    } else {
        None
    };
    update_pitch_history(pitch_history, now_secs, pitch_hz, confidence);
    let (bend_cents, vibrato_depth, vibrato_rate) =
        pitch_motion(pitch_history, pitch_hz, confidence);
    let mut chroma = spectral.chroma;
    if let Some(pitch) = pitch_hz.filter(|_| spectral.harmonic_density < 0.75) {
        let pitch_class = pitch_class_from_freq(pitch);
        chroma[pitch_class] += confidence * 1.3;
        normalize_chroma(&mut chroma);
    }
    let harmonic_density = harmonic_density(&chroma);
    let note_name = pitch_hz.map(note_name);
    let note_stability = match (previous_pitch, pitch_hz) {
        (Some(prev), Some(next)) => {
            let cents = (1200.0 * (next / prev).log2()).abs();
            (previous_stability * 0.9 + (1.0 - (cents / 55.0).clamp(0.0, 1.0)) * confidence * 0.1)
                .clamp(0.0, 1.0)
        }
        (_, Some(_)) => (previous_stability * 0.92 + confidence * 0.08).clamp(0.0, 1.0),
        _ => previous_stability * 0.88,
    };
    let chord = detect_chord(&chroma, harmonic_density);
    let harmonic_ratio = harmonic_ratio(&spectral.magnitudes, sample_rate, pitch_hz);
    let pick_noise = (spectral_flux * 0.45 + spectral.brightness * 0.32 + spectral.flatness * 0.23)
        .clamp(0.0, 1.0);
    let mute_amount = if gate {
        (decay * 0.34 + spectral_flux * 0.18 + spectral.flatness * 0.24 + spectral.high * 0.18
            - note_stability * 0.12)
            .clamp(0.0, 1.0)
    } else {
        0.0
    };
    let (string_number, fret_number, fretted_confidence) = infer_string_fret(pitch_hz, confidence)
        .map(|candidate| (Some(candidate.0), Some(candidate.1), candidate.2))
        .unwrap_or((None, None, 0.0));
    let voicing = infer_voicing(&chroma, pitch_hz, chord.confidence.max(fretted_confidence));
    let (guitar_technique, guitar_technique_confidence) = classify_guitar_technique(
        gate,
        pitch_hz,
        confidence,
        harmonic_density,
        chord.confidence,
        spectral_flux,
        pick_noise,
        mute_amount,
        spectral.flatness,
        bend_cents,
        vibrato_depth,
        vibrato_rate,
    );

    let mut features = AudioFeatures {
        t: 0.0,
        rms: rms as f64,
        peak: peak as f64,
        low: spectral.low as f64,
        mid: spectral.mid as f64,
        high: spectral.high as f64,
        spectral_centroid: spectral.centroid as f64,
        pitch_hz: pitch_hz.map(|pitch| pitch as f64),
        pitch_confidence: confidence as f64,
        note_name,
        note_stability: note_stability as f64,
        onset: onset as f64,
        gate,
        clipping,
        chroma: chroma.iter().map(|value| *value as f64).collect(),
        spectral_flux: spectral_flux as f64,
        spectral_rolloff: spectral.rolloff as f64,
        spectral_flatness: spectral.flatness as f64,
        zero_crossing_rate: zero_crossing_rate as f64,
        brightness: spectral.brightness as f64,
        noisiness: (spectral.flatness * 0.72 + zero_crossing_rate * 0.28).clamp(0.0, 1.0) as f64,
        attack: attack as f64,
        decay: decay as f64,
        bend_cents: bend_cents as f64,
        vibrato_depth: vibrato_depth as f64,
        vibrato_rate: vibrato_rate as f64,
        harmonic_density: harmonic_density as f64,
        chord_root: chord.root,
        chord_quality: chord.quality,
        chord_name: chord.name,
        chord_confidence: chord.confidence as f64,
        log_spectrum: spectral
            .log_spectrum
            .iter()
            .map(|value| *value as f64)
            .collect(),
        spectral_contrast: spectral.contrast as f64,
        harmonic_ratio: harmonic_ratio as f64,
        pick_noise: pick_noise as f64,
        mute_amount: mute_amount as f64,
        guitar_technique,
        guitar_technique_confidence: guitar_technique_confidence as f64,
        string_number,
        fret_number,
        voicing,
        guitar_events: Vec::new(),
    };
    guitar_state.update(&mut features, now_secs);
    features
}

fn rms(samples: &[f32]) -> f32 {
    (samples.iter().map(|sample| sample * sample).sum::<f32>() / samples.len() as f32).sqrt()
}

fn peak(samples: &[f32]) -> f32 {
    samples
        .iter()
        .fold(0.0_f32, |acc, sample| acc.max(sample.abs()))
        .clamp(0.0, 1.5)
}

struct SpectralFrame {
    low: f32,
    mid: f32,
    high: f32,
    centroid: f32,
    rolloff: f32,
    flatness: f32,
    brightness: f32,
    harmonic_density: f32,
    chroma: [f32; CHROMA_BINS],
    log_spectrum: [f32; LOG_SPECTRUM_BINS],
    contrast: f32,
    magnitudes: Vec<f32>,
}

fn spectral_features(
    samples: &[f32],
    sample_rate: f32,
    fft: &Arc<dyn rustfft::Fft<f32>>,
    fft_buffer: &mut [Complex<f32>],
) -> SpectralFrame {
    for (index, slot) in fft_buffer.iter_mut().enumerate() {
        let sample = samples.get(index).copied().unwrap_or(0.0);
        let hann = 0.5 - 0.5 * ((2.0 * PI * index as f32) / (FFT_SIZE - 1) as f32).cos();
        *slot = Complex::new(sample * hann, 0.0);
    }

    fft.process(fft_buffer);

    let mut low = 0.0;
    let mut mid = 0.0;
    let mut high = 0.0;
    let mut weighted = 0.0;
    let mut total = 0.0;
    let mut bright = 0.0;
    let mut chroma = [0.0_f32; CHROMA_BINS];
    let mut magnitudes = vec![0.0_f32; FFT_SIZE / 2];

    for (index, value) in fft_buffer.iter().take(FFT_SIZE / 2).enumerate().skip(1) {
        let freq = index as f32 * sample_rate / FFT_SIZE as f32;
        let mag = value.norm();
        magnitudes[index] = mag;
        total += mag;
        weighted += mag * freq;
        if freq < 220.0 {
            low += mag;
        } else if freq < 1600.0 {
            mid += mag;
        } else if freq < 8000.0 {
            high += mag;
        }
        if freq >= 2000.0 && freq < 8000.0 {
            bright += mag;
        }
        if (70.0..=5000.0).contains(&freq) {
            let midi = 69.0 + 12.0 * (freq / 440.0).log2();
            let damping = 1.0 / (1.0 + freq / 3500.0);
            for (pitch_class, slot) in chroma.iter_mut().enumerate() {
                let distance = pitch_class_distance(midi, pitch_class);
                let weight = (-((distance * distance) / (2.0 * 0.72 * 0.72))).exp();
                *slot += mag * damping * weight;
            }
        }
    }

    let scale = (low + mid + high).max(0.0001);
    let centroid_hz = if total > 0.0001 {
        weighted / total
    } else {
        0.0
    };
    let rolloff_hz = rolloff_hz(&magnitudes, sample_rate, total * 0.85);
    let flatness = spectral_flatness(&magnitudes);
    let log_spectrum = log_spectrum(&magnitudes, sample_rate);
    let contrast = spectral_contrast(&magnitudes, sample_rate);
    normalize_chroma(&mut chroma);
    let harmonic_density = harmonic_density(&chroma);

    SpectralFrame {
        low: (low / scale).clamp(0.0, 1.0),
        mid: (mid / scale).clamp(0.0, 1.0),
        high: (high / scale).clamp(0.0, 1.0),
        centroid: (centroid_hz / 5000.0).clamp(0.0, 1.0),
        rolloff: (rolloff_hz / 8000.0).clamp(0.0, 1.0),
        flatness,
        brightness: (bright / scale).clamp(0.0, 1.0),
        harmonic_density,
        chroma,
        log_spectrum,
        contrast,
        magnitudes,
    }
}

fn pitch_class_distance(midi: f32, pitch_class: usize) -> f32 {
    let class = midi.rem_euclid(CHROMA_BINS as f32);
    let direct = (class - pitch_class as f32).abs();
    direct.min(CHROMA_BINS as f32 - direct)
}

fn spectral_flux(current: &[f32], previous: &[f32]) -> f32 {
    let mut positive_delta = 0.0;
    let mut total = 0.0;
    for (next, prev) in current.iter().zip(previous.iter()) {
        positive_delta += (next - prev).max(0.0);
        total += *next;
    }
    (positive_delta / total.max(0.0001) * 1.8).clamp(0.0, 1.0)
}

fn rolloff_hz(magnitudes: &[f32], sample_rate: f32, threshold: f32) -> f32 {
    let mut cumulative = 0.0;
    for (index, mag) in magnitudes.iter().enumerate().skip(1) {
        cumulative += *mag;
        if cumulative >= threshold {
            return index as f32 * sample_rate / FFT_SIZE as f32;
        }
    }
    0.0
}

fn spectral_flatness(magnitudes: &[f32]) -> f32 {
    let mut count = 0.0;
    let mut log_sum = 0.0;
    let mut sum = 0.0;
    for mag in magnitudes.iter().skip(1) {
        let value = *mag + 0.000001;
        log_sum += value.ln();
        sum += value;
        count += 1.0;
    }
    if count == 0.0 || sum <= 0.000001 {
        return 0.0;
    }
    let geometric = (log_sum / count).exp();
    let arithmetic = sum / count;
    (geometric / arithmetic.max(0.000001)).clamp(0.0, 1.0)
}

fn log_spectrum(magnitudes: &[f32], sample_rate: f32) -> [f32; LOG_SPECTRUM_BINS] {
    let mut bins = [0.0_f32; LOG_SPECTRUM_BINS];
    let min_freq = 70.0_f32;
    let max_freq = 6000.0_f32;
    let log_min = min_freq.ln();
    let log_max = max_freq.ln();

    for (index, mag) in magnitudes.iter().enumerate().skip(1) {
        let freq = index as f32 * sample_rate / FFT_SIZE as f32;
        if !(min_freq..=max_freq).contains(&freq) {
            continue;
        }
        let bin = (((freq.ln() - log_min) / (log_max - log_min)) * LOG_SPECTRUM_BINS as f32)
            .floor()
            .clamp(0.0, (LOG_SPECTRUM_BINS - 1) as f32) as usize;
        bins[bin] += *mag;
    }

    let max = bins.iter().copied().fold(0.0_f32, f32::max);
    if max > 0.0001 {
        for bin in bins.iter_mut() {
            *bin = (*bin / max).sqrt().clamp(0.0, 1.0);
        }
    }
    bins
}

fn spectral_contrast(magnitudes: &[f32], sample_rate: f32) -> f32 {
    let bands = [
        (80.0_f32, 160.0_f32),
        (160.0, 320.0),
        (320.0, 640.0),
        (640.0, 1280.0),
        (1280.0, 2560.0),
        (2560.0, 5120.0),
    ];
    let mut total = 0.0;
    let mut count = 0.0;

    for (low, high) in bands {
        let mut values = Vec::new();
        for (index, mag) in magnitudes.iter().enumerate().skip(1) {
            let freq = index as f32 * sample_rate / FFT_SIZE as f32;
            if freq >= low && freq < high {
                values.push(*mag);
            }
        }
        if values.len() < 4 {
            continue;
        }
        values.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        let low_mean = values.iter().take(values.len() / 4).sum::<f32>() / (values.len() / 4).max(1) as f32;
        let high_mean = values
            .iter()
            .rev()
            .take(values.len() / 4)
            .sum::<f32>()
            / (values.len() / 4).max(1) as f32;
        total += ((high_mean - low_mean) / high_mean.max(0.0001)).clamp(0.0, 1.0);
        count += 1.0;
    }

    if count > 0.0 {
        (total / count).clamp(0.0, 1.0)
    } else {
        0.0
    }
}

fn harmonic_ratio(magnitudes: &[f32], sample_rate: f32, pitch_hz: Option<f32>) -> f32 {
    let Some(pitch) = pitch_hz else {
        return 0.0;
    };
    if pitch <= 0.0 {
        return 0.0;
    }

    let mut harmonic = 0.0;
    let mut total = 0.0;
    for (index, mag) in magnitudes.iter().enumerate().skip(1) {
        let freq = index as f32 * sample_rate / FFT_SIZE as f32;
        if !(60.0..=6000.0).contains(&freq) {
            continue;
        }
        total += *mag;
        let nearest_harmonic = (freq / pitch).round().max(1.0);
        let harmonic_freq = nearest_harmonic * pitch;
        let tolerance = (pitch * 0.045).max(9.0);
        if (freq - harmonic_freq).abs() <= tolerance {
            harmonic += *mag;
        }
    }
    (harmonic / total.max(0.0001)).clamp(0.0, 1.0)
}

fn normalize_chroma(chroma: &mut [f32; CHROMA_BINS]) {
    let max = chroma.iter().copied().fold(0.0_f32, f32::max);
    if max <= 0.0001 {
        return;
    }
    for value in chroma.iter_mut() {
        *value = (*value / max).clamp(0.0, 1.0);
    }
}

fn harmonic_density(chroma: &[f32; CHROMA_BINS]) -> f32 {
    let active = chroma.iter().filter(|value| **value > 0.22).count() as f32;
    let energy = chroma.iter().sum::<f32>() / CHROMA_BINS as f32;
    ((active / 6.0) * 0.68 + energy * 0.32).clamp(0.0, 1.0)
}

fn zero_crossing_rate(samples: &[f32]) -> f32 {
    if samples.len() < 2 {
        return 0.0;
    }
    let crossings = samples
        .windows(2)
        .filter(|pair| (pair[0] >= 0.0 && pair[1] < 0.0) || (pair[0] < 0.0 && pair[1] >= 0.0))
        .count();
    (crossings as f32 / (samples.len() - 1) as f32 * 8.0).clamp(0.0, 1.0)
}

struct ChordEstimate {
    root: Option<String>,
    quality: Option<String>,
    name: Option<String>,
    confidence: f32,
}

fn detect_chord(chroma: &[f32; CHROMA_BINS], harmonic_density: f32) -> ChordEstimate {
    let templates: [(&str, &[(usize, f32)]); 9] = [
        ("major", &[(0, 1.0), (4, 0.82), (7, 0.92)]),
        ("minor", &[(0, 1.0), (3, 0.82), (7, 0.92)]),
        ("power", &[(0, 1.0), (7, 0.95)]),
        ("sus2", &[(0, 1.0), (2, 0.74), (7, 0.9)]),
        ("sus4", &[(0, 1.0), (5, 0.74), (7, 0.9)]),
        ("major7", &[(0, 1.0), (4, 0.78), (7, 0.9), (11, 0.62)]),
        ("minor7", &[(0, 1.0), (3, 0.78), (7, 0.9), (10, 0.62)]),
        ("dominant7", &[(0, 1.0), (4, 0.78), (7, 0.9), (10, 0.62)]),
        ("add9", &[(0, 1.0), (4, 0.76), (7, 0.88), (2, 0.58)]),
    ];
    let mut best_root = 0;
    let mut best_quality = "";
    let mut best_score = 0.0;
    let mut next_score = 0.0;

    for root in 0..CHROMA_BINS {
        for (quality, intervals) in templates {
            let mut score = chord_score(chroma, root, intervals);
            if quality == "power"
                && chroma[(root + 3) % CHROMA_BINS].max(chroma[(root + 4) % CHROMA_BINS]) < 0.52
            {
                score = (score * 1.16).clamp(0.0, 1.0);
            }
            if score > best_score {
                next_score = best_score;
                best_score = score;
                best_root = root;
                best_quality = quality;
            } else if score > next_score {
                next_score = score;
            }
        }
    }

    let confidence = (best_score * (0.82 + (best_score - next_score).max(0.0) * 0.36)).clamp(0.0, 1.0);
    if confidence >= 0.48 {
        let root = NOTE_NAMES[best_root].to_string();
        let name = chord_name(&root, best_quality);
        return ChordEstimate {
            root: Some(root),
            quality: Some(best_quality.to_string()),
            name: Some(name),
            confidence,
        };
    }

    let active_count = chroma.iter().filter(|value| **value > 0.34).count();
    if harmonic_density > 0.34 && active_count <= 2 {
        let root_index = chroma
            .iter()
            .enumerate()
            .max_by(|a, b| a.1.partial_cmp(b.1).unwrap_or(std::cmp::Ordering::Equal))
            .map(|(index, _)| index)
            .unwrap_or(0);
        let root = NOTE_NAMES[root_index].to_string();
        return ChordEstimate {
            root: Some(root.clone()),
            quality: Some("dyad".to_string()),
            name: Some(chord_name(&root, "dyad")),
            confidence: harmonic_density * 0.58,
        };
    }

    if harmonic_density > 0.34 {
        return ChordEstimate {
            root: None,
            quality: Some("unknown".to_string()),
            name: Some("Unknown".to_string()),
            confidence: harmonic_density * 0.5,
        };
    }

    ChordEstimate {
        root: None,
        quality: None,
        name: None,
        confidence: 0.0,
    }
}

fn chord_score(chroma: &[f32; CHROMA_BINS], root: usize, intervals: &[(usize, f32)]) -> f32 {
    let mut template = [0.0_f32; CHROMA_BINS];
    for (interval, weight) in intervals {
        template[(root + *interval) % CHROMA_BINS] = *weight;
    }
    let dot = chroma
        .iter()
        .zip(template.iter())
        .map(|(a, b)| a * b)
        .sum::<f32>();
    let chroma_norm = chroma.iter().map(|value| value * value).sum::<f32>().sqrt();
    let template_norm = template.iter().map(|value| value * value).sum::<f32>().sqrt();
    let cosine = dot / (chroma_norm * template_norm).max(0.0001);
    let active_bonus = intervals
        .iter()
        .map(|(interval, _)| chroma[(root + *interval) % CHROMA_BINS])
        .sum::<f32>()
        / intervals.len() as f32;
    let coverage = intervals
        .iter()
        .filter(|(interval, _)| chroma[(root + *interval) % CHROMA_BINS] > 0.28)
        .count() as f32
        / intervals.len() as f32;
    let extension_penalty = if intervals.len() > 3 {
        let extension_energy = intervals
            .iter()
            .skip(3)
            .map(|(interval, _)| chroma[(root + *interval) % CHROMA_BINS])
            .sum::<f32>()
            / (intervals.len() - 3) as f32;
        coverage * (extension_energy / 0.55).clamp(0.0, 1.0)
    } else {
        1.0
    };
    ((cosine * 0.78 + active_bonus * 0.22) * (0.72 + coverage * 0.28) * extension_penalty)
        .clamp(0.0, 1.0)
}

fn chord_name(root: &str, quality: &str) -> String {
    match quality {
        "major" => root.to_string(),
        "minor" => format!("{root}m"),
        "power" => format!("{root}5"),
        "sus2" => format!("{root}sus2"),
        "sus4" => format!("{root}sus4"),
        "major7" => format!("{root}maj7"),
        "minor7" => format!("{root}m7"),
        "dominant7" => format!("{root}7"),
        "add9" => format!("{root}add9"),
        "dyad" => format!("{root} dyad"),
        _ => "Unknown".to_string(),
    }
}

fn classify_guitar_technique(
    gate: bool,
    pitch_hz: Option<f32>,
    pitch_confidence: f32,
    harmonic_density: f32,
    chord_confidence: f32,
    spectral_flux: f32,
    pick_noise: f32,
    mute_amount: f32,
    spectral_flatness: f32,
    bend_cents: f32,
    vibrato_depth: f32,
    vibrato_rate: f32,
) -> (String, f32) {
    if !gate {
        return ("idle".to_string(), 1.0);
    }
    if pick_noise > 0.68 && pitch_confidence < 0.34 {
        return ("scrape".to_string(), pick_noise);
    }
    if spectral_flatness > 0.58 && pitch_confidence < 0.28 {
        return ("noise".to_string(), spectral_flatness);
    }
    if mute_amount > 0.55 && spectral_flux > 0.18 {
        return ("palm_mute".to_string(), mute_amount.max(spectral_flux));
    }
    if vibrato_depth > 0.18 && vibrato_rate > 0.16 {
        return ("vibrato".to_string(), vibrato_depth.max(vibrato_rate));
    }
    if bend_cents.abs() > 45.0 && pitch_confidence > 0.38 {
        return ("bend".to_string(), (bend_cents.abs() / 160.0).clamp(0.0, 1.0));
    }
    if chord_confidence > 0.45 || harmonic_density > 0.54 {
        return ("strum".to_string(), chord_confidence.max(harmonic_density));
    }
    if pitch_hz.is_some() && pitch_confidence > 0.45 {
        let confidence = if spectral_flux < 0.18 {
            pitch_confidence.max(0.52)
        } else {
            pitch_confidence
        };
        return ("single_note".to_string(), confidence);
    }
    ("sustain".to_string(), pitch_confidence.max(0.35))
}

fn infer_string_fret(pitch_hz: Option<f32>, pitch_confidence: f32) -> Option<(u32, u32, f32)> {
    let pitch = pitch_hz?;
    if pitch <= 0.0 || pitch_confidence < 0.25 {
        return None;
    }
    let midi = 69.0 + 12.0 * (pitch / 440.0).log2();
    let nearest = midi.round() as i32;
    let cents = (midi - nearest as f32).abs() * 100.0;
    let mut best = None::<(u32, u32, f32, f32)>;

    for (string_number, open_midi) in GUITAR_TUNING {
        let fret = nearest - open_midi;
        if !(0..=24).contains(&fret) {
            continue;
        }
        let position_penalty = if fret <= 12 { fret as f32 * 0.018 } else { 0.22 + fret as f32 * 0.022 };
        let score = cents / 70.0 + position_penalty + (6_u32.saturating_sub(string_number) as f32) * 0.006;
        let confidence = (pitch_confidence * (1.0 - cents / 65.0).clamp(0.25, 1.0)
            * (1.0 - position_penalty * 0.55).clamp(0.2, 1.0))
            .clamp(0.0, 1.0);
        match best {
            Some((_, _, best_score, _)) if best_score <= score => {}
            _ => best = Some((string_number, fret as u32, score, confidence)),
        }
    }

    best.map(|(string_number, fret, _, confidence)| (string_number, fret, confidence))
}

fn infer_voicing(
    chroma: &[f32; CHROMA_BINS],
    pitch_hz: Option<f32>,
    base_confidence: f32,
) -> Vec<GuitarVoicingCandidate> {
    let mut active = chroma
        .iter()
        .enumerate()
        .filter(|(_, value)| **value > 0.24)
        .map(|(pitch_class, value)| (pitch_class as u32, *value))
        .collect::<Vec<_>>();
    active.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    active.truncate(6);

    let mut voicing = Vec::new();
    for (pitch_class, energy) in active {
        if let Some((string_number, fret_number, confidence)) =
            infer_pitch_class_position(pitch_class, energy * base_confidence.max(0.35), pitch_hz)
        {
            if !voicing
                .iter()
                .any(|candidate: &GuitarVoicingCandidate| candidate.string_number == string_number)
            {
                voicing.push(GuitarVoicingCandidate {
                    string_number,
                    fret_number,
                    pitch_class,
                    confidence: confidence as f64,
                });
            }
        }
    }
    voicing.sort_by(|a, b| b.string_number.cmp(&a.string_number));
    voicing
}

fn infer_pitch_class_position(
    pitch_class: u32,
    confidence: f32,
    pitch_hz: Option<f32>,
) -> Option<(u32, u32, f32)> {
    if let Some((string_number, fret_number, mono_confidence)) = infer_string_fret(pitch_hz, confidence) {
        let midi = GUITAR_TUNING
            .iter()
            .find(|(candidate_string, _)| *candidate_string == string_number)
            .map(|(_, open)| open + fret_number as i32)
            .unwrap_or(0);
        if midi.rem_euclid(CHROMA_BINS as i32) as u32 == pitch_class {
            return Some((string_number, fret_number, mono_confidence));
        }
    }

    let mut best = None::<(u32, u32, f32)>;
    for (string_number, open_midi) in GUITAR_TUNING {
        for fret in 0..=15 {
            let class = (open_midi + fret).rem_euclid(CHROMA_BINS as i32) as u32;
            if class != pitch_class {
                continue;
            }
            let score = fret as f32 * 0.035 + (6_u32.saturating_sub(string_number) as f32) * 0.01;
            let candidate_confidence = (confidence * (1.0 - score).clamp(0.25, 1.0)).clamp(0.0, 1.0);
            match best {
                Some((_, _, best_confidence)) if best_confidence >= candidate_confidence => {}
                _ => best = Some((string_number, fret as u32, candidate_confidence)),
            }
        }
    }
    best
}

fn detect_pitch_mpm(samples: &[f32], sample_rate: f32) -> (Option<f32>, f32) {
    let min_freq = 70.0;
    let max_freq = 700.0;
    let min_tau = (sample_rate / max_freq) as usize;
    let max_tau = (sample_rate / min_freq).min((samples.len() / 2) as f32) as usize;
    let mut best_tau = 0;
    let mut best = 0.0;

    for tau in min_tau..max_tau {
        let nsdf = nsdf_at_tau(samples, tau);
        if nsdf > best {
            best = nsdf;
            best_tau = tau;
        }
    }

    if best_tau == 0 || best < 0.22 {
        return (None, best.max(0.0));
    }

    let refined_tau = if best_tau > min_tau && best_tau + 1 < max_tau {
        let left = nsdf_at_tau(samples, best_tau - 1);
        let center = best;
        let right = nsdf_at_tau(samples, best_tau + 1);
        let denominator = left - 2.0 * center + right;
        if denominator.abs() > 0.000001 {
            best_tau as f32 + 0.5 * (left - right) / denominator
        } else {
            best_tau as f32
        }
    } else {
        best_tau as f32
    };
    let pitch = sample_rate / refined_tau.max(1.0);
    (Some(pitch), best.clamp(0.0, 1.0))
}

fn nsdf_at_tau(samples: &[f32], tau: usize) -> f32 {
    let mut acf = 0.0;
    let mut divisor = 0.0;
    for index in 0..(samples.len() - tau) {
        acf += samples[index] * samples[index + tau];
        divisor += samples[index] * samples[index] + samples[index + tau] * samples[index + tau];
    }
    if divisor > 0.0 {
        2.0 * acf / divisor
    } else {
        0.0
    }
}

fn update_pitch_history(
    history: &mut VecDeque<(f64, f32)>,
    now_secs: f64,
    pitch_hz: Option<f32>,
    confidence: f32,
) {
    while let Some((t, _)) = history.front() {
        if now_secs - *t <= 0.5 {
            break;
        }
        history.pop_front();
    }

    if let Some(pitch) = pitch_hz {
        if confidence > 0.35 && pitch.is_finite() && pitch > 0.0 {
            history.push_back((now_secs, pitch));
        }
    }
}

fn pitch_motion(
    history: &VecDeque<(f64, f32)>,
    pitch_hz: Option<f32>,
    confidence: f32,
) -> (f32, f32, f32) {
    let Some(pitch) = pitch_hz else {
        return (0.0, 0.0, 0.0);
    };
    if confidence <= 0.35 {
        return (0.0, 0.0, 0.0);
    }

    let midi = 69.0 + 12.0 * (pitch / 440.0).log2();
    let bend_cents = (midi - midi.round()) * 100.0;

    if history.len() < 5 {
        return (bend_cents, 0.0, 0.0);
    }

    let mean_midi = history
        .iter()
        .map(|(_, pitch)| 69.0 + 12.0 * (*pitch / 440.0).log2())
        .sum::<f32>()
        / history.len() as f32;
    let cents: Vec<f32> = history
        .iter()
        .map(|(_, pitch)| (69.0 + 12.0 * (*pitch / 440.0).log2() - mean_midi) * 100.0)
        .collect();
    let min = cents.iter().copied().fold(f32::INFINITY, f32::min);
    let max = cents.iter().copied().fold(f32::NEG_INFINITY, f32::max);
    let vibrato_depth = ((max - min) / 80.0).clamp(0.0, 1.0);
    let duration = (history.back().unwrap().0 - history.front().unwrap().0).max(0.001);
    let crossings = cents
        .windows(2)
        .filter(|pair| (pair[0] >= 0.0 && pair[1] < 0.0) || (pair[0] < 0.0 && pair[1] >= 0.0))
        .count();
    let rate_hz = crossings as f64 / (duration * 2.0);
    let vibrato_rate = (rate_hz as f32 / 9.0).clamp(0.0, 1.0) * if vibrato_depth > 0.08 { 1.0 } else { 0.0 };

    (bend_cents, vibrato_depth, vibrato_rate)
}

fn pitch_class_from_freq(freq: f32) -> usize {
    let midi = (69.0 + 12.0 * (freq / 440.0).log2()).round() as i32;
    midi.rem_euclid(CHROMA_BINS as i32) as usize
}

fn note_name(freq: f32) -> String {
    let midi = (69.0 + 12.0 * (freq / 440.0).log2()).round() as i32;
    let name = NOTE_NAMES[pitch_class_from_freq(freq)];
    let octave = midi.div_euclid(12) - 1;
    format!("{name}{octave}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sine(freq: f32, sample_rate: f32, len: usize, amp: f32) -> Vec<f32> {
        (0..len)
            .map(|index| (2.0 * PI * freq * index as f32 / sample_rate).sin() * amp)
            .collect()
    }

    fn analyze(samples: &[f32], previous_rms: f32) -> AudioFeatures {
        let mut planner = FftPlanner::<f32>::new();
        let fft = planner.plan_fft_forward(FFT_SIZE);
        let mut fft_buffer = vec![Complex::new(0.0, 0.0); FFT_SIZE];
        let mut previous_magnitudes =
            spectral_features(samples, 48_000.0, &fft, &mut fft_buffer).magnitudes;
        let mut pitch_history = VecDeque::new();
        let mut guitar_state = GuitarAnalyzerState::new();
        analyze_window(
            samples,
            48_000.0,
            0.02,
            previous_rms,
            None,
            0.0,
            0.5,
            &mut previous_magnitudes,
            &mut pitch_history,
            &mut guitar_state,
            &fft,
            &mut fft_buffer,
        )
    }

    fn mix_sines(freqs: &[f32], sample_rate: f32, len: usize, amp: f32) -> Vec<f32> {
        (0..len)
            .map(|index| {
                freqs
                    .iter()
                    .map(|freq| (2.0 * PI * *freq * index as f32 / sample_rate).sin())
                    .sum::<f32>()
                    * amp
                    / freqs.len() as f32
            })
            .collect()
    }

    fn guitar_note(freq: f32) -> Vec<f32> {
        (0..FFT_SIZE)
            .map(|index| {
                let t = index as f32 / 48_000.0;
                ((2.0 * PI * freq * t).sin() * 0.58
                    + (2.0 * PI * freq * 2.0 * t).sin() * 0.28
                    + (2.0 * PI * freq * 3.0 * t).sin() * 0.14)
                    * 0.8
            })
            .collect()
    }

    #[test]
    fn rms_and_peak_are_correct() {
        let samples = vec![0.5; FFT_SIZE];
        assert!((rms(&samples) - 0.5).abs() < 0.001);
        assert!((peak(&samples) - 0.5).abs() < 0.001);
    }

    #[test]
    fn gate_opens_above_threshold() {
        let quiet = vec![0.001; FFT_SIZE];
        let loud = vec![0.08; FFT_SIZE];
        assert!(!analyze(&quiet, 0.0).gate);
        assert!(analyze(&loud, 0.0).gate);
    }

    #[test]
    fn spectral_centroid_increases_for_bright_signal() {
        let low = sine(110.0, 48_000.0, FFT_SIZE, 0.7);
        let high = sine(3000.0, 48_000.0, FFT_SIZE, 0.7);
        assert!(analyze(&high, 0.0).spectral_centroid > analyze(&low, 0.0).spectral_centroid);
    }

    #[test]
    fn spectral_bands_react_to_sine_waves() {
        let low = analyze(&sine(110.0, 48_000.0, FFT_SIZE, 0.7), 0.0);
        let mid = analyze(&sine(880.0, 48_000.0, FFT_SIZE, 0.7), 0.0);
        let high = analyze(&sine(3200.0, 48_000.0, FFT_SIZE, 0.7), 0.0);
        assert!(low.low > low.mid);
        assert!(mid.mid > mid.low);
        assert!(high.high > high.mid);
    }

    #[test]
    fn pitch_detector_identifies_guitar_notes() {
        for expected in [82.41, 110.0, 146.83, 196.0] {
            let samples = sine(expected, 48_000.0, FFT_SIZE, 0.8);
            let (pitch, confidence) = detect_pitch_mpm(&samples, 48_000.0);
            let pitch = pitch.expect("pitch should be detected");
            assert!(confidence > 0.6);
            assert!((pitch - expected).abs() / expected < 0.04);
        }
    }

    #[test]
    fn onset_fires_on_rms_jump() {
        let samples = sine(110.0, 48_000.0, FFT_SIZE, 0.8);
        assert!(analyze(&samples, 0.02).onset > 0.5);
        assert!(analyze(&samples, 0.56).onset < 0.1);
    }

    #[test]
    fn chroma_peaks_for_guitar_notes() {
        for (freq, expected_class) in [(82.41, 4), (110.0, 9), (146.83, 2), (196.0, 7)] {
            let features = analyze(&guitar_note(freq), 0.0);
            let peak_class = features
                .chroma
                .iter()
                .enumerate()
                .max_by(|a, b| a.1.partial_cmp(b.1).unwrap())
                .map(|(index, _)| index)
                .unwrap();
            assert_eq!(peak_class, expected_class);
        }
    }

    #[test]
    fn chord_templates_classify_common_guitar_chords() {
        let c_major = analyze(&mix_sines(&[261.63, 329.63, 392.0], 48_000.0, FFT_SIZE, 0.8), 0.0);
        assert_eq!(c_major.chord_root.as_deref(), Some("C"));
        assert_eq!(c_major.chord_quality.as_deref(), Some("major"));

        let a_minor = analyze(&mix_sines(&[220.0, 261.63, 329.63], 48_000.0, FFT_SIZE, 0.8), 0.0);
        assert_eq!(a_minor.chord_root.as_deref(), Some("A"));
        assert_eq!(a_minor.chord_quality.as_deref(), Some("minor"));

        let e_power = analyze(&mix_sines(&[82.41, 123.47], 48_000.0, FFT_SIZE, 0.8), 0.0);
        assert_eq!(e_power.chord_root.as_deref(), Some("E"));
        assert_eq!(e_power.chord_quality.as_deref(), Some("power"));
    }

    #[test]
    fn spectral_flux_rises_on_spectral_change() {
        let low = sine(110.0, 48_000.0, FFT_SIZE, 0.7);
        let high = sine(2200.0, 48_000.0, FFT_SIZE, 0.7);
        let mut planner = FftPlanner::<f32>::new();
        let fft = planner.plan_fft_forward(FFT_SIZE);
        let mut fft_buffer = vec![Complex::new(0.0, 0.0); FFT_SIZE];
        let mut previous_magnitudes =
            spectral_features(&low, 48_000.0, &fft, &mut fft_buffer).magnitudes;
        let mut pitch_history = VecDeque::new();
        let mut guitar_state = GuitarAnalyzerState::new();
        let features = analyze_window(
            &high,
            48_000.0,
            0.02,
            rms(&high),
            None,
            0.0,
            0.5,
            &mut previous_magnitudes,
            &mut pitch_history,
            &mut guitar_state,
            &fft,
            &mut fft_buffer,
        );
        assert!(features.spectral_flux > 0.5);
        assert!(features.onset > 0.5);
    }

    #[test]
    fn texture_descriptors_separate_noise_and_brightness() {
        let noise = (0..FFT_SIZE)
            .map(|index| (((index * 17 + 23) % 97) as f32 / 48.5 - 1.0) * 0.4)
            .collect::<Vec<_>>();
        let sine_low = sine(110.0, 48_000.0, FFT_SIZE, 0.7);
        let sine_high = sine(3200.0, 48_000.0, FFT_SIZE, 0.7);
        let noise_features = analyze(&noise, 0.0);
        let low_features = analyze(&sine_low, 0.0);
        let high_features = analyze(&sine_high, 0.0);
        assert!(noise_features.spectral_flatness > low_features.spectral_flatness);
        assert!(noise_features.noisiness > low_features.noisiness);
        assert!(high_features.spectral_rolloff > low_features.spectral_rolloff);
        assert!(high_features.brightness > low_features.brightness);
    }

    #[test]
    fn pitch_motion_detects_bends_and_vibrato() {
        let mut history = VecDeque::new();
        for i in 0..24 {
            let t = i as f64 / 48.0;
            let pitch = 220.0 * 2.0_f32.powf((30.0 * (t as f32 * 2.0 * PI * 5.0).sin()) / 1200.0);
            update_pitch_history(&mut history, t, Some(pitch), 0.9);
        }
        let (bend_cents, vibrato_depth, vibrato_rate) = pitch_motion(&history, Some(226.45), 0.9);
        assert!(bend_cents.abs() > 40.0);
        assert!(vibrato_depth > 0.2);
        assert!(vibrato_rate > 0.2);
    }

    #[test]
    fn log_spectrum_tracks_frequency_regions() {
        let low = analyze(&sine(110.0, 48_000.0, FFT_SIZE, 0.7), 0.0);
        let mid = analyze(&sine(880.0, 48_000.0, FFT_SIZE, 0.7), 0.0);
        let high = analyze(&sine(3600.0, 48_000.0, FFT_SIZE, 0.7), 0.0);
        let low_peak = low
            .log_spectrum
            .iter()
            .enumerate()
            .max_by(|a, b| a.1.partial_cmp(b.1).unwrap())
            .map(|(index, _)| index)
            .unwrap();
        let mid_peak = mid
            .log_spectrum
            .iter()
            .enumerate()
            .max_by(|a, b| a.1.partial_cmp(b.1).unwrap())
            .map(|(index, _)| index)
            .unwrap();
        let high_peak = high
            .log_spectrum
            .iter()
            .enumerate()
            .max_by(|a, b| a.1.partial_cmp(b.1).unwrap())
            .map(|(index, _)| index)
            .unwrap();
        assert!(low_peak < mid_peak);
        assert!(mid_peak < high_peak);
        assert_eq!(low.log_spectrum.len(), LOG_SPECTRUM_BINS);
    }

    #[test]
    fn pick_noise_and_palm_mute_have_distinct_descriptors() {
        let sustained = analyze(&guitar_note(110.0), 0.18);
        let muted = analyze(&sine(110.0, 48_000.0, FFT_SIZE, 0.26), 0.72);
        let scratch = (0..FFT_SIZE)
            .map(|index| (((index * 31 + 7) % 113) as f32 / 56.5 - 1.0) * 0.35)
            .collect::<Vec<_>>();
        let scratch_features = analyze(&scratch, 0.0);
        assert!(muted.mute_amount > sustained.mute_amount);
        assert!(scratch_features.pick_noise > sustained.pick_noise);
    }

    #[test]
    fn guitar_state_emits_gesture_events() {
        let mut state = GuitarAnalyzerState::new();
        let mut note = AudioFeatures {
            t: 0.1,
            rms: 0.3,
            onset: 0.78,
            gate: true,
            pitch_hz: Some(110.0),
            pitch_confidence: 0.82,
            note_name: Some("A2".to_string()),
            string_number: Some(5),
            fret_number: Some(0),
            guitar_technique: "single_note".to_string(),
            guitar_technique_confidence: 0.8,
            ..AudioFeatures::default()
        };
        state.update(&mut note, 0.1);
        assert!(note.guitar_events.iter().any(|event| event.r#type == "note_on"));
        assert!(note.guitar_events.iter().any(|event| event.r#type == "pluck"));

        let mut bend = AudioFeatures {
            t: 0.22,
            rms: 0.32,
            gate: true,
            pitch_hz: Some(116.5),
            pitch_confidence: 0.82,
            bend_cents: 95.0,
            note_name: Some("A#2".to_string()),
            string_number: Some(5),
            fret_number: Some(1),
            guitar_technique: "bend".to_string(),
            guitar_technique_confidence: 0.7,
            ..AudioFeatures::default()
        };
        state.update(&mut bend, 0.22);
        assert!(bend.guitar_events.iter().any(|event| event.r#type == "bend"));
    }

    #[test]
    fn string_fret_inference_prefers_standard_open_strings() {
        let e2 = infer_string_fret(Some(82.41), 0.9).unwrap();
        assert_eq!((e2.0, e2.1), (6, 0));
        let a2 = infer_string_fret(Some(110.0), 0.9).unwrap();
        assert_eq!((a2.0, a2.1), (5, 0));
        let e3 = infer_string_fret(Some(164.81), 0.9).unwrap();
        assert_eq!((e3.0, e3.1), (4, 2));
    }

    #[test]
    fn expanded_chord_templates_classify_sevenths_and_add9() {
        let mut chroma = [0.0_f32; CHROMA_BINS];
        for pitch_class in [0, 4, 7, 11] {
            chroma[pitch_class] = 1.0;
        }
        let c_major7 = detect_chord(&chroma, harmonic_density(&chroma));
        assert_eq!(c_major7.root.as_deref(), Some("C"));
        assert_eq!(c_major7.quality.as_deref(), Some("major7"));

        chroma = [0.0_f32; CHROMA_BINS];
        for pitch_class in [9, 1, 4, 7] {
            chroma[pitch_class] = 1.0;
        }
        let a7 = detect_chord(&chroma, harmonic_density(&chroma));
        assert_eq!(a7.root.as_deref(), Some("A"));
        assert_eq!(a7.quality.as_deref(), Some("dominant7"));

        chroma = [0.0_f32; CHROMA_BINS];
        for pitch_class in [2, 6, 9, 4] {
            chroma[pitch_class] = 1.0;
        }
        let d_add9 = detect_chord(&chroma, harmonic_density(&chroma));
        assert_eq!(d_add9.root.as_deref(), Some("D"));
        assert_eq!(d_add9.quality.as_deref(), Some("add9"));
    }
}
