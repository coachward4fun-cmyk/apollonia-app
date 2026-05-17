import React, { useRef, useState, useEffect } from 'react';
import { TouchableOpacity, StyleSheet, Platform, View, Text, Animated } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { WebView } from 'react-native-webview';
import { useAIAssistant } from '../context/AIAssistantContext';

const GREEN = '#16a34a';
const TAB_BAR_HEIGHT = Platform.OS === 'ios' ? 60 : 56;

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
  } = useAIAssistant();

  const insets     = useSafeAreaInsets();
  const webViewRef = useRef(null);

  const [status,       setStatus]       = useState('idle'); // idle | listening | processing
  const [webViewReady, setWebViewReady] = useState(false);
  const pulseAnim      = useRef(new Animated.Value(1)).current;
  const pulseLoop      = useRef(null);
  const statusRef      = useRef('idle');
  const listeningSource = useRef('manual'); // 'manual' | 'auto'

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

  // ── Long-press: start manual recording ───────────────────────────────────────

  const handleLongPress = () => {
    if (!webViewReady) { openPanel(); return; }
    stopSpeaking(); // stop AI speech so mic picks up user, not speaker echo
    listeningSource.current = 'manual';
    setStatus('listening');
    webViewRef.current?.injectJavaScript('startRecognition(false); true;');
  };

  // ── Release: stop manual recording ───────────────────────────────────────────

  const handlePressOut = () => {
    if (statusRef.current !== 'listening' || listeningSource.current !== 'manual') return;
    setStatus('processing');
    webViewRef.current?.injectJavaScript('stopRecognition(); true;');
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
              onPress={status === 'idle' ? openPanel : undefined}
              onLongPress={handleLongPress}
              onPressOut={handlePressOut}
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
