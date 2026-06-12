import React, { createContext, useContext, useState, useCallback, useRef, useEffect } from 'react';
import * as Speech from 'expo-speech';
// expo-av's audio-mode API is deprecated in SDK 54 and silently no-ops in EAS
// builds — that's what killed TTS audibility there. expo-audio replaces it.
import { setAudioModeAsync } from 'expo-audio';
import AsyncStorage from '@react-native-async-storage/async-storage';

const VOICE_KEY = 'apollonia:ai_voice_enabled';

const AIAssistantContext = createContext(null);

// voiceFlow shape:
// null | { type: 'new_job'|'new_customer'|'edit_job', step: number, data: {}, paused: boolean, confirming: boolean, confirmData: {}|null }

export function AIAssistantProvider({ children }) {
  const [isOpen,           setIsOpen]           = useState(false);
  const [isProcessing,     setIsProcessing]     = useState(false);
  const [isSpeaking,       setIsSpeaking]       = useState(false);
  const [conversation,     setConversation]     = useState([]);
  const [pendingAction,    setPendingAction]    = useState(null);
  const [pendingVoiceText, setPendingVoiceText] = useState(null);
  const [voiceFlow,        setVoiceFlow]        = useState(null);
  const [listenStatus,     setListenStatus]     = useState('idle'); // 'idle'|'waiting'|'listening'

  const [voiceEnabled,   setVoiceEnabled]   = useState(true);
  const voiceEnabledRef  = useRef(true);

  // Voice session = the user entered via the floating-mic tap, which forces TTS
  // on for the duration of the session regardless of the persisted voiceEnabled
  // toggle. Ends on closePanel.
  const [voiceSessionActive, setVoiceSessionActive] = useState(false);
  const voiceSessionRef = useRef(false);

  // Load persisted voice preference once on mount
  useEffect(() => {
    AsyncStorage.getItem(VOICE_KEY).then((val) => {
      if (val === 'false') {
        setVoiceEnabled(false);
        voiceEnabledRef.current = false;
      }
    }).catch(() => {});
  }, []);

  // Warm up the iOS audio session at app start. The very first
  // setAudioModeAsync call after launch is sometimes not ready when speakText
  // fires, which leaves TTS silent on the first attempt. Pre-initializing here
  // means the audio mode is already configured by the time the user taps the
  // mic. Failures are swallowed — there's nothing meaningful to do at mount.
  useEffect(() => {
    setAudioModeAsync({
      playsInSilentMode:      true,
      allowsRecording:        false,
      shouldPlayInBackground: false,
    }).catch(() => {});
  }, []);

  const toggleVoice = useCallback((enabled) => {
    setVoiceEnabled(enabled);
    voiceEnabledRef.current = enabled;
    AsyncStorage.setItem(VOICE_KEY, String(enabled)).catch(() => {});
  }, []);

  const _listenControls = useRef({ start: null, stop: null });
  const _autoListenCb   = useRef(null);
  const _interimCb      = useRef(null);

  // Tracks the last voice transcript handed off via submitVoiceText so we can
  // drop an identical follow-up that arrives within ~1 second — guards against
  // duplicate WebView 'result' messages from doubling the user's message.
  const lastSubmitRef = useRef({ text: null, ts: 0 });

  // ── Panel lifecycle ───────────────────────────────────────────────────────────

  const openPanel = useCallback(() => {
    Speech.stop();
    setIsSpeaking(false);
    setIsOpen(true);
  }, []);

  const submitVoiceText = useCallback((text) => {
    // Drop a same-text repeat within 1 second — defense-in-depth against any
    // future path that double-fires the result (e.g. a different speech
    // backend, an injected stopRecognition race, etc.). The WebView already
    // dedupes onend, but this is the last line of defense.
    const now = Date.now();
    if (text && text === lastSubmitRef.current.text && now - lastSubmitRef.current.ts < 1000) {
      return; // duplicate within 1 second — drop it
    }
    lastSubmitRef.current = { text, ts: now };

    // NOTE: deliberately NOT calling Speech.stop() / setIsSpeaking(false) here.
    // handleTap already stops TTS before the mic starts, and stopping again
    // when the transcript arrives interrupts any in-flight TTS mid-sentence
    // (e.g. an AI question that's still being spoken when the user replies).
    setPendingVoiceText(text || null);
    setIsOpen(true);
  }, []);

  const clearPendingVoiceText = useCallback(() => {
    setPendingVoiceText(null);
  }, []);

  const closePanel = useCallback(() => {
    setIsOpen(false);
    setIsProcessing(false);
    Speech.stop();
    setIsSpeaking(false);
    _listenControls.current.stop?.();
    _autoListenCb.current = null;
    setListenStatus('idle');
    setVoiceSessionActive(false);
    voiceSessionRef.current = false;
  }, []);

  const startVoiceSession = useCallback(() => {
    setVoiceSessionActive(true);
    voiceSessionRef.current = true;
  }, []);

  const endVoiceSession = useCallback(() => {
    setVoiceSessionActive(false);
    voiceSessionRef.current = false;
  }, []);

  // ── TTS — accepts optional onDone callback ────────────────────────────────────

  const speakText = useCallback(async (text, { onDone } = {}) => {
    console.log('[Speech] speakText called — voiceEnabledRef:', voiceEnabledRef.current, 'voiceSessionRef:', voiceSessionRef.current, 'text:', (text || '').slice(0, 60));
    // Voice-session override: when the user entered via the mic tap, TTS is on
    // for the whole session regardless of the persisted voiceEnabled toggle.
    if (!voiceEnabledRef.current && !voiceSessionRef.current) {
      // Voice off — skip TTS but fire onDone so speakAndListen can still open the mic.
      console.log('[Speech] gate short-circuited — TTS skipped');
      onDone?.();
      return;
    }

    // iOS audio-session reset: speech recognition (mic) puts the AVAudioSession
    // into record-only mode. Without flipping it back, expo-speech calls
    // succeed silently — no audible output. Setting playback mode here means
    // every TTS call starts with a clean playback-capable session.
    try {
      await setAudioModeAsync({
        playsInSilentMode:        true,
        allowsRecording:          false,
        shouldPlayInBackground:   false,
      });
    } catch (e) {
      console.warn('[Speech] setAudioModeAsync failed:', e.message);
    }

    console.log('[Speech] AI speaking started');
    Speech.stop();
    setIsSpeaking(true);
    Speech.speak(text, {
      language: 'en-US',
      rate:     0.9,
      pitch:    1.0,
      onDone: () => {
        console.log('[Speech] AI speaking finished (onDone fired)');
        setIsSpeaking(false);
        onDone?.();
      },
      onError: () => { setIsSpeaking(false); },
    });
  }, []);

  const stopSpeaking = useCallback(() => {
    Speech.stop();
    setIsSpeaking(false);
  }, []);

  // ── Auto-listen controls (registered by FloatingMicButton) ────────────────────

  const registerListenControls = useCallback((start, stop) => {
    _listenControls.current = { start, stop };
  }, []);

  // startAutoListen: sets status to 'waiting'; FloatingMicButton sees the change
  // and triggers the WebView after 500ms, then sets status to 'listening'.
  const startAutoListen = useCallback((onResult) => {
    _autoListenCb.current = onResult;
    setListenStatus('waiting');
  }, []);

  const stopAutoListen = useCallback(() => {
    _listenControls.current.stop?.();
    _autoListenCb.current = null;
    setListenStatus('idle');
  }, []);

  // Interim callback — registered by AIAssistantPanel, called by FloatingMicButton
  // when speech recognition detects the first audio input in auto mode.
  const registerInterimCallback = useCallback((fn) => {
    _interimCb.current = fn;
  }, []);

  const notifyAutoListenInterim = useCallback(() => {
    _interimCb.current?.();
    _interimCb.current = null; // one-shot
  }, []);

  // Called by FloatingMicButton when auto-mode recognition completes.
  const deliverAutoListenResult = useCallback((text) => {
    setListenStatus('idle');
    const cb = _autoListenCb.current;
    _autoListenCb.current = null;
    cb?.(text);
  }, []);

  // ── Conversation ──────────────────────────────────────────────────────────────

  const addMessage = useCallback((msg) => {
    setConversation((prev) => [...prev, msg]);
  }, []);

  const clearConversation = useCallback(() => {
    setConversation([]);
    setPendingAction(null);
  }, []);

  // ── Voice flow ────────────────────────────────────────────────────────────────

  const startVoiceFlow = useCallback((type) => {
    setVoiceFlow({ type, step: 0, data: {}, paused: false, confirming: false, confirmData: null });
  }, []);

  const cancelVoiceFlow = useCallback(() => setVoiceFlow(null), []);

  const pauseVoiceFlow = useCallback(() => {
    setVoiceFlow((f) => f ? { ...f, paused: true } : f);
  }, []);

  const resumeVoiceFlow = useCallback(() => {
    setVoiceFlow((f) => f ? { ...f, paused: false } : f);
  }, []);

  return (
    <AIAssistantContext.Provider value={{
      isOpen, openPanel, closePanel,
      isProcessing, setIsProcessing,
      isSpeaking, speakText, stopSpeaking,
      voiceEnabled, toggleVoice,
      voiceSessionActive, startVoiceSession, endVoiceSession,
      conversation, addMessage, clearConversation,
      pendingAction, setPendingAction,
      pendingVoiceText, submitVoiceText, clearPendingVoiceText,
      voiceFlow, setVoiceFlow, startVoiceFlow, cancelVoiceFlow, pauseVoiceFlow, resumeVoiceFlow,
      listenStatus, setListenStatus,
      registerListenControls, startAutoListen, stopAutoListen, deliverAutoListenResult,
      registerInterimCallback, notifyAutoListenInterim,
    }}>
      {children}
    </AIAssistantContext.Provider>
  );
}

export const useAIAssistant = () => useContext(AIAssistantContext);
