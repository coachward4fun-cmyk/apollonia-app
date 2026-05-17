import React, { createContext, useContext, useState, useCallback, useRef, useEffect } from 'react';
import * as Speech from 'expo-speech';
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

  // Load persisted voice preference once on mount
  useEffect(() => {
    AsyncStorage.getItem(VOICE_KEY).then((val) => {
      if (val === 'false') {
        setVoiceEnabled(false);
        voiceEnabledRef.current = false;
      }
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

  // ── Panel lifecycle ───────────────────────────────────────────────────────────

  const openPanel = useCallback(() => {
    Speech.stop();
    setIsSpeaking(false);
    setIsOpen(true);
  }, []);

  const submitVoiceText = useCallback((text) => {
    Speech.stop();
    setIsSpeaking(false);
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
  }, []);

  // ── TTS — accepts optional onDone callback ────────────────────────────────────

  const speakText = useCallback((text, { onDone } = {}) => {
    if (!voiceEnabledRef.current) {
      // Voice off — skip TTS but fire onDone so speakAndListen can still open the mic.
      onDone?.();
      return;
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
