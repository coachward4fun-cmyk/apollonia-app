import React, { useRef, useState, useEffect } from 'react';
import { TouchableOpacity, StyleSheet, Platform, View, Text, Animated } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { WebView } from 'react-native-webview';
import Constants from 'expo-constants';
import { useAIAssistant } from '../context/AIAssistantContext';

const GREEN = '#16a34a';
const TAB_BAR_HEIGHT = Platform.OS === 'ios' ? 60 : 56;

// Expo Go can't bundle the native expo-speech-recognition module — fall back
// to the WebView speech recognizer there. Native builds (dev / preview /
// production via EAS) get the proper Apple Speech framework via the module.
const IS_EXPO_GO = Constants.appOwnership === 'expo';
let SpeechModule = null;
if (!IS_EXPO_GO) {
  // Top-level require is guarded so Expo Go never tries to load the native code.
  // Defensive try/catch so a missing/misconfigured native binary in an EAS
  // build degrades to "no native speech" rather than crashing the whole bundle.
  try {
    SpeechModule = require('expo-speech-recognition').ExpoSpeechRecognitionModule;
  } catch (e) {
    console.warn('[SpeechModule] Failed to load expo-speech-recognition:', e.message);
  }
}

// Hidden WebView running iOS Web Speech API (webkitSpeechRecognition).
// Supports two modes:
//   'start'     — manual (continuous=true, hold-to-record)
//   'startAuto' — auto   (continuous=false, stops after first utterance)
const SPEECH_HTML = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>
<body>
<script>
var recognition = null;
var finalTranscript = '';
var active = false;

function notify(obj) {
  try { window.ReactNativeWebView.postMessage(JSON.stringify(obj)); } catch(e) {}
}

function startRecognition(isAuto) {
  if (active) return;
  var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { notify({type:'error', error:'not_supported'}); return; }
  finalTranscript = '';
  active = true;
  recognition = new SR();
  recognition.continuous = !isAuto;
  recognition.interimResults = true; // always on; auto mode uses it for interim_started detection
  recognition.lang = 'en-US';
  recognition.maxAlternatives = 1;

  var interimStartedSent = false;
  recognition.onresult = function(e) {
    for (var i = e.resultIndex; i < e.results.length; i++) {
      if (e.results[i].isFinal) {
        finalTranscript += e.results[i][0].transcript + ' ';
        if (isAuto && finalTranscript.trim()) {
          recognition.stop();
        }
      } else if (isAuto && !interimStartedSent) {
        interimStartedSent = true;
        notify({type: 'interim_started'});
      }
    }
  };
  recognition.onerror = function(e) {
    active = false;
    recognition = null;
    notify({type:'error', error: e.error || 'recognition_error'});
  };
  recognition.onend = function() {
    active = false;
    recognition = null;
    notify({type:'result', text: finalTranscript.trim()});
  };
  try {
    recognition.start();
    notify({type:'started'});
  } catch(e) {
    active = false;
    recognition = null;
    notify({type:'error', error: e.message || 'start_failed'});
  }
}

function stopRecognition() {
  if (recognition && active) {
    recognition.stop();
  } else {
    notify({type:'result', text: finalTranscript.trim()});
  }
}

window.addEventListener('message', function(e) {
  if (e.data === 'start')     startRecognition(false);
  else if (e.data === 'startAuto') startRecognition(true);
  else if (e.data === 'stop') stopRecognition();
});
document.addEventListener('message', function(e) {
  if (e.data === 'start')     startRecognition(false);
  else if (e.data === 'startAuto') startRecognition(true);
  else if (e.data === 'stop') stopRecognition();
});
</script>
</body>
</html>`;

export default function FloatingMicButton() {
  const {
    isOpen, openPanel, submitVoiceText,
    listenStatus, setListenStatus,
    registerListenControls, deliverAutoListenResult,
    notifyAutoListenInterim, stopSpeaking,
    startVoiceSession, endVoiceSession,
  } = useAIAssistant();

  const insets     = useSafeAreaInsets();
  const webViewRef = useRef(null);

  const [status,       setStatus]       = useState('idle'); // idle | listening | processing
  const [webViewReady, setWebViewReady] = useState(false);
  const pulseAnim      = useRef(new Animated.Value(1)).current;
  const pulseLoop      = useRef(null);
  const statusRef      = useRef('idle');
  const listeningSource = useRef('manual'); // 'manual' | 'auto'
  // Set when the user taps before the WebView has finished loading. The
  // onLoadEnd effect below fires the recognition start as soon as it's ready.
  const pendingAutoListenRef = useRef(false);

  useEffect(() => { statusRef.current = status; }, [status]);

  // Register start/stop controls with context so AIAssistantPanel can trigger auto-listen
  useEffect(() => {
    if (!webViewReady) return;
    registerListenControls(
      () => {
        listeningSource.current = 'auto';
        webViewRef.current?.injectJavaScript('startRecognition(true); true;');
      },
      () => {
        webViewRef.current?.injectJavaScript('stopRecognition(); true;');
      },
    );
  }, [webViewReady, registerListenControls]);

  // When context sets listenStatus → 'waiting', start mic immediately.
  // The 500ms echo-prevention delay is handled upstream in speakAndListen's onDone.
  useEffect(() => {
    if (listenStatus !== 'waiting' || !webViewReady) return;
    console.log('[Mic] Starting to listen...');
    setListenStatus('listening');
    listeningSource.current = 'auto';
    webViewRef.current?.injectJavaScript('startRecognition(true); true;');
  }, [listenStatus, webViewReady, setListenStatus]);

  // Pulsing green glow while listening (manual button only)
  useEffect(() => {
    if (status === 'listening') {
      pulseLoop.current = Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, { toValue: 1.28, duration: 480, useNativeDriver: true }),
          Animated.timing(pulseAnim, { toValue: 1.0,  duration: 480, useNativeDriver: true }),
        ])
      );
      pulseLoop.current.start();
    } else {
      pulseLoop.current?.stop();
      pulseLoop.current = null;
      pulseAnim.setValue(1);
    }
  }, [status]);

  const bottomOffset = TAB_BAR_HEIGHT + insets.bottom + 4;

  // ── Single tap: open panel + start voice session + auto-listen (single utterance) ──
  //
  // The auto-mode WebView call stops on its own when the user pauses, so no
  // press-out handling is needed. The result routes through submitVoiceText
  // (listeningSource='manual') which fires handleSend automatically. The voice
  // session keeps TTS on for the duration regardless of the user's voice toggle.

  // Native speech recognition (EAS builds only). Wires expo-speech-recognition
  // events to the same submitVoiceText path the WebView uses, so handleSend
  // sees no difference between the two paths.
  useEffect(() => {
    if (IS_EXPO_GO || !SpeechModule) return;

    const resultSub = SpeechModule.addListener('result', (event) => {
      const transcript = event.results?.[0]?.transcript;
      if (event.isFinal && transcript) {
        setStatus('idle');
        setListenStatus('idle');
        submitVoiceText(transcript);
      }
    });

    const endSub = SpeechModule.addListener('end', () => {
      setStatus('idle');
      setListenStatus('idle');
    });

    const errorSub = SpeechModule.addListener('error', (event) => {
      console.warn('[SpeechNative] error:', event.error);
      setStatus('idle');
      setListenStatus('idle');
    });

    return () => {
      resultSub.remove();
      endSub.remove();
      errorSub.remove();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleTap = () => {
    console.log('[TAP] fired — IS_EXPO_GO:', IS_EXPO_GO, 'webViewReady:', webViewReady, 'status:', statusRef.current);

    if (statusRef.current === 'listening') {
      openPanel();
      return;
    }

    stopSpeaking();
    startVoiceSession();
    openPanel();
    listeningSource.current = 'manual';
    setStatus('listening');
    setListenStatus('listening');

    if (IS_EXPO_GO || !SpeechModule) {
      // Expo Go OR native build where SpeechModule failed to load — fall back
      // to the WebView recognizer so the user still gets voice input.
      if (!webViewReady) {
        console.log('[TAP] WebView path — not ready, queuing');
        pendingAutoListenRef.current = true;
        return;
      }
      console.log('[TAP] WebView path — injecting startRecognition');
      webViewRef.current?.injectJavaScript('startRecognition(true); true;');
    } else {
      // Native build path — starts programmatically, single tap
      console.log('[TAP] Native — starting expo-speech-recognition');
      SpeechModule.requestPermissionsAsync().then(({ granted }) => {
        if (granted) {
          SpeechModule.start({ lang: 'en-US', interimResults: false, continuous: false });
        } else {
          console.warn('[SpeechNative] microphone permission denied');
          setStatus('idle');
          setListenStatus('idle');
          endVoiceSession();
        }
      });
    }
  };

  // Drain the queued auto-listen the moment the WebView finishes loading.
  // Only relevant in Expo Go; native builds never enter the queued state.
  useEffect(() => {
    if (webViewReady && pendingAutoListenRef.current) {
      pendingAutoListenRef.current = false;
      webViewRef.current?.injectJavaScript('startRecognition(true); true;');
    }
  }, [webViewReady]);

  // ── Long press: open panel for typed input (no mic) ──────────────────────────
  //
  // Power-user fallback. No visible cue — the user has to know it's available.

  const handleLongPress = () => {
    openPanel();
  };

  // ── WebView message handler ───────────────────────────────────────────────────

  const handleWebViewMessage = (event) => {
    let data;
    try { data = JSON.parse(event.nativeEvent.data); } catch { return; }

    if (data.type === 'started') return;

    if (data.type === 'interim_started') {
      if (listeningSource.current === 'auto') {
        console.log('[Mic] User started speaking - timeout cleared');
        notifyAutoListenInterim();
      }
      return;
    }

    if (data.type === 'result') {
      const text = (data.text || '').trim();
      if (listeningSource.current === 'auto') {
        listeningSource.current = 'manual';
        deliverAutoListenResult(text);
      } else {
        setStatus('idle');
        setListenStatus('idle');
        if (text) {
          submitVoiceText(text);
        } else if (isOpen) {
          // Only reopen for an empty manual result if the panel is already open.
          // Guards against residual WebView events firing after the panel is closed
          // (iOS can fire both onerror AND onend when recognition is stopped, which
          // would reset listeningSource to 'manual' on the first event, then hit
          // this else-branch on the second event and call openPanel on a closed panel).
          openPanel();
        }
      }
      return;
    }

    if (data.type === 'error') {
      if (listeningSource.current === 'auto') {
        listeningSource.current = 'manual';
        deliverAutoListenResult('');
      } else {
        setStatus('idle');
        if (isOpen) openPanel(); // Same guard: don't reopen a panel that was just closed
      }
    }
  };

  // ── Render ────────────────────────────────────────────────────────────────────

  const bgColor = status === 'listening' ? '#15803d' : status === 'processing' ? '#6b7280' : GREEN;
  const icon    = status === 'listening' ? 'mic' : status === 'processing' ? 'ellipsis-horizontal' : 'sparkles';
  const label   = status === 'listening' ? 'Listening…' : status === 'processing' ? 'Thinking…' : null;

  return (
    <>
      <View style={styles.hiddenWebViewContainer}>
        <WebView
          ref={webViewRef}
          source={{ html: SPEECH_HTML }}
          style={styles.hiddenWebView}
          onMessage={handleWebViewMessage}
          onLoadEnd={() => setWebViewReady(true)}
          allowsInlineMediaPlayback
          mediaPlaybackRequiresUserAction={false}
          javaScriptEnabled
          scrollEnabled={false}
        />
      </View>

      {!isOpen && (
        <View style={[styles.wrapper, { bottom: bottomOffset }]}>
          {label ? (
            <View style={styles.labelBubble}>
              <Text style={styles.labelText}>{label}</Text>
            </View>
          ) : null}

          <Animated.View style={{ transform: [{ scale: pulseAnim }] }}>
            <TouchableOpacity
              style={[styles.button, { backgroundColor: bgColor }]}
              onPress={handleTap}
              onLongPress={handleLongPress}
              delayLongPress={400}
              activeOpacity={0.85}
            >
              <Ionicons name={icon} size={22} color="#fff" />
            </TouchableOpacity>
          </Animated.View>
        </View>
      )}
    </>
  );
}

const styles = StyleSheet.create({
  hiddenWebViewContainer: {
    position: 'absolute',
    width: 1,
    height: 1,
    top: -1000,
    left: -1000,
    overflow: 'hidden',
  },
  hiddenWebView: { flex: 1 },
  wrapper: {
    position: 'absolute',
    right: 18,
    zIndex: 9999,
    alignItems: 'center',
  },
  button: {
    width: 54,
    height: 54,
    borderRadius: 27,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.28,
    shadowRadius: 7,
    elevation: 10,
  },
  labelBubble: {
    backgroundColor: 'rgba(0,0,0,0.72)',
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 5,
    marginBottom: 8,
  },
  labelText: { color: '#fff', fontSize: 13, fontWeight: '600' },
});
