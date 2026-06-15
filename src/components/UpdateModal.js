import React, { useState } from 'react';
import {
  View, Text, StyleSheet, Modal, TouchableOpacity, Linking,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { Ionicons } from '@expo/vector-icons';
import { colors } from '../theme/colors';

// Full-screen update overlay shown by App.js when this device is behind the
// published build. Non-blocking: "I'll upgrade later" dismisses it for the
// session; it re-appears on the next launch while still behind.
export default function UpdateModal({ info, onDismiss }) {
  const [copied, setCopied] = useState(false);

  if (!info?.installUrl) return null;
  const { installUrl, version, buildNumber } = info;

  const handleCopy = async () => {
    try {
      await Clipboard.setStringAsync(installUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch (e) {
      console.warn('[UpdateModal] copy failed:', e?.message || e);
    }
  };

  const handleOpen = () => {
    Linking.openURL(installUrl).catch((err) =>
      console.warn('[UpdateModal] open URL failed:', err?.message || err));
  };

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onDismiss} statusBarTranslucent>
      <View style={styles.backdrop}>
        <View style={styles.card}>
          <View style={styles.iconCircle}>
            <Ionicons name="cloud-download-outline" size={28} color={colors.primary} />
          </View>

          <Text style={styles.title}>Update Available</Text>

          <Text style={styles.body}>
            A new version of Apollonia is available.{'\n\n'}
            Version {version || '—'} (Build {buildNumber || '—'}){'\n\n'}
            Open Chrome on your iPhone and go to this link to install:
          </Text>

          <View style={styles.urlBox}>
            <Text style={styles.urlText} selectable>{installUrl}</Text>
          </View>

          <TouchableOpacity style={[styles.btn, styles.btnCopy]} onPress={handleCopy} activeOpacity={0.85}>
            <Ionicons name={copied ? 'checkmark' : 'copy-outline'} size={16} color="#fff" />
            <Text style={styles.btnText}>{copied ? 'Copied!' : 'Copy Link'}</Text>
          </TouchableOpacity>

          <TouchableOpacity style={[styles.btn, styles.btnOpen]} onPress={handleOpen} activeOpacity={0.85}>
            <Ionicons name="open-outline" size={16} color="#fff" />
            <Text style={styles.btnText}>Open in Browser</Text>
          </TouchableOpacity>

          <TouchableOpacity style={styles.laterBtn} onPress={onDismiss} activeOpacity={0.7} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
            <Text style={styles.laterText}>I'll upgrade later</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  card: {
    width: '100%',
    maxWidth: 380,
    backgroundColor: '#fff',
    borderRadius: 18,
    paddingHorizontal: 22,
    paddingTop: 22,
    paddingBottom: 18,
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.2,
    shadowRadius: 16,
    elevation: 8,
  },
  iconCircle: {
    width: 56, height: 56, borderRadius: 28,
    backgroundColor: '#f0fdf4',
    alignItems: 'center', justifyContent: 'center',
    marginBottom: 12,
  },
  title: { fontSize: 20, fontWeight: '800', color: '#111827', marginBottom: 10 },
  body: { fontSize: 14, color: '#374151', textAlign: 'center', lineHeight: 20, marginBottom: 14 },
  urlBox: {
    width: '100%',
    backgroundColor: '#f3f4f6',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#e5e7eb',
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginBottom: 16,
  },
  urlText: {
    fontSize: 12,
    color: '#111827',
    fontFamily: 'Courier',
    letterSpacing: 0.2,
  },
  btn: {
    width: '100%',
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    borderRadius: 12,
    paddingVertical: 13,
    marginBottom: 10,
  },
  btnCopy: { backgroundColor: '#16a34a' }, // green
  btnOpen: { backgroundColor: '#2563eb' }, // blue
  btnText: { color: '#fff', fontSize: 15, fontWeight: '700' },
  laterBtn: { paddingVertical: 8, marginTop: 2 },
  laterText: { fontSize: 13, color: colors.textMuted, fontWeight: '500' },
});
