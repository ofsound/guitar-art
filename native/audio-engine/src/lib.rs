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

const FFT_SIZE: usize = 2048;
const SAMPLE_QUEUE_CAPACITY: usize = 48_000;

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
        }
    }
}

struct RunningEngine {
    stop: Arc<AtomicBool>,
    stream: Option<cpal::Stream>,
    dsp_thread: Option<JoinHandle<()>>,
}

struct LiveAudioParams {
    input_gain_bits: AtomicU32,
    gate_threshold_bits: AtomicU32,
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
            mode: "simulator".to_string(),
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

        let channel_index = config.channel_index.min(channels.saturating_sub(1) as u32) as usize;
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
}

impl Drop for AudioEngine {
    fn drop(&mut self) {
        self.stop();
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
    channel_index: usize,
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
                if let Some(sample) = frame.get(channel_index) {
                    let value = sample.to_sample::<f32>() * input_gain;
                    let _ = producer.push(value);
                }
            }
        },
        err_fn,
        None,
    )
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
            let mut features = analyze_window(
                samples,
                sample_rate,
                params.gate_threshold(),
                last_rms,
                stable_pitch,
                note_stability,
                &fft,
                &mut fft_buffer,
            );
            features.t = started.elapsed().as_secs_f64();
            last_rms = features.rms as f32;
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
    fft: &Arc<dyn rustfft::Fft<f32>>,
    fft_buffer: &mut [Complex<f32>],
) -> AudioFeatures {
    let rms = rms(samples);
    let peak = peak(samples);
    let clipping = peak > 0.98;
    let gate = rms > gate_threshold;
    let onset = ((rms - previous_rms).max(0.0) * 8.0).clamp(0.0, 1.0);
    let (low, mid, high, spectral_centroid) =
        spectral_features(samples, sample_rate, fft, fft_buffer);
    let (pitch_hz, confidence) = detect_pitch_mpm(samples, sample_rate);
    let pitch_hz = if gate && confidence > 0.22 {
        pitch_hz
    } else {
        None
    };
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

    AudioFeatures {
        t: 0.0,
        rms: rms as f64,
        peak: peak as f64,
        low: low as f64,
        mid: mid as f64,
        high: high as f64,
        spectral_centroid: spectral_centroid as f64,
        pitch_hz: pitch_hz.map(|pitch| pitch as f64),
        pitch_confidence: confidence as f64,
        note_name,
        note_stability: note_stability as f64,
        onset: onset as f64,
        gate,
        clipping,
    }
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

fn spectral_features(
    samples: &[f32],
    sample_rate: f32,
    fft: &Arc<dyn rustfft::Fft<f32>>,
    fft_buffer: &mut [Complex<f32>],
) -> (f32, f32, f32, f32) {
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

    for (index, value) in fft_buffer.iter().take(FFT_SIZE / 2).enumerate().skip(1) {
        let freq = index as f32 * sample_rate / FFT_SIZE as f32;
        let mag = value.norm();
        total += mag;
        weighted += mag * freq;
        if freq < 220.0 {
            low += mag;
        } else if freq < 1600.0 {
            mid += mag;
        } else if freq < 8000.0 {
            high += mag;
        }
    }

    let scale = (low + mid + high).max(0.0001);
    let centroid_hz = if total > 0.0001 {
        weighted / total
    } else {
        0.0
    };
    (
        (low / scale).clamp(0.0, 1.0),
        (mid / scale).clamp(0.0, 1.0),
        (high / scale).clamp(0.0, 1.0),
        (centroid_hz / 5000.0).clamp(0.0, 1.0),
    )
}

fn detect_pitch_mpm(samples: &[f32], sample_rate: f32) -> (Option<f32>, f32) {
    let min_freq = 70.0;
    let max_freq = 700.0;
    let min_tau = (sample_rate / max_freq) as usize;
    let max_tau = (sample_rate / min_freq).min((samples.len() / 2) as f32) as usize;
    let mut best_tau = 0;
    let mut best = 0.0;

    for tau in min_tau..max_tau {
        let mut acf = 0.0;
        let mut divisor = 0.0;
        for index in 0..(samples.len() - tau) {
            acf += samples[index] * samples[index + tau];
            divisor +=
                samples[index] * samples[index] + samples[index + tau] * samples[index + tau];
        }
        let nsdf = if divisor > 0.0 {
            2.0 * acf / divisor
        } else {
            0.0
        };
        if nsdf > best {
            best = nsdf;
            best_tau = tau;
        }
    }

    if best_tau == 0 || best < 0.22 {
        return (None, best.max(0.0));
    }

    let pitch = sample_rate / best_tau as f32;
    (Some(pitch), best.clamp(0.0, 1.0))
}

fn note_name(freq: f32) -> String {
    let midi = (69.0 + 12.0 * (freq / 440.0).log2()).round() as i32;
    let names = [
        "C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B",
    ];
    let name = names[midi.rem_euclid(12) as usize];
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
        analyze_window(
            samples,
            48_000.0,
            0.02,
            previous_rms,
            None,
            0.0,
            &fft,
            &mut fft_buffer,
        )
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
}
