import React, { useState, useEffect } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity,
  Modal, Linking, Image,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

// ─── Update this date when renewing the app subscription ─────────────────────
const APP_EXPIRY = '2026-08-04';
// ─────────────────────────────────────────────────────────────────────────────

const DISMISSED_KEY = 'apollonia:warningDismissed';

function todayString() {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

function getDaysLeft() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const expiry = new Date(APP_EXPIRY + 'T00:00:00');
  return Math.floor((expiry - today) / (1000 * 60 * 60 * 24));
}

function getWarningMessage(daysLeft) {
  if (daysLeft === 10)
    return '⚠ This app will expire in 10 days. Please contact Scott Ward to request an app update and avoid losing access to your data.';
  if (daysLeft === 7)
    return '⚠ This app will expire in 7 days. Contact Scott Ward immediately to schedule an app update and prevent data loss.';
  if (daysLeft >= 4)
    return `⚠ This app will expire in ${daysLeft} days. Please contact Scott Ward to request an app update and avoid losing access to your data.`;
  if (daysLeft === 3)
    return '🚨 URGENT: This app expires in 3 days. You will lose access to all features. Contact Scott Ward NOW at coachward4fun@gmail.com or 402-312-3535.';
  if (daysLeft === 2)
    return '🚨 URGENT: This app expires in 2 days. You will lose access to all features. Contact Scott Ward NOW at coachward4fun@gmail.com or 402-312-3535.';
  if (daysLeft === 1)
    return '🚨 CRITICAL: This app expires TOMORROW. Contact Scott Ward immediately at coachward4fun@gmail.com or 402-312-3535 to prevent loss of access.';
  return null;
}

// ── Expired full-screen block ─────────────────────────────────────────────────

export function ExpiryBlockScreen() {
  const insets = useSafeAreaInsets();
  const isExpired = getDaysLeft() <= 0;
  return (
    <Modal visible={isExpired} animationType="none" statusBarTranslucent>
      <View style={[blockStyles.container, { paddingTop: insets.top + 24, paddingBottom: insets.bottom + 24 }]}>
        <Image
          source={require('../../assets/Apollonia_new.png')}
          style={blockStyles.logo}
          resizeMode="contain"
        />
        <Text style={blockStyles.title}>App Update Required</Text>
        <Text style={blockStyles.message}>
          This app has expired and requires an update. All your data is safe in the cloud.
          Contact Scott Ward to restore access.
        </Text>
        <View style={blockStyles.contactCard}>
          <Text style={blockStyles.contactLabel}>Scott Ward</Text>
          <TouchableOpacity
            style={blockStyles.contactRow}
            onPress={() => Linking.openURL('mailto:coachward4fun@gmail.com')}
            activeOpacity={0.7}
          >
            <Text style={blockStyles.contactLink}>coachward4fun@gmail.com</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={blockStyles.contactRow}
            onPress={() => Linking.openURL('tel:4023123535')}
            activeOpacity={0.7}
          >
            <Text style={blockStyles.contactLink}>402-312-3535</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

// ── Dismissible / non-dismissible warning banner ──────────────────────────────

export function ExpiryBanner() {
  const insets = useSafeAreaInsets();
  const [dismissed, setDismissed] = useState(false);
  const [ready, setReady]         = useState(false);

  const daysLeft = getDaysLeft();

  useEffect(() => {
    if (daysLeft > 10 || daysLeft <= 0) { setReady(true); return; }
    AsyncStorage.getItem(DISMISSED_KEY).then((stored) => {
      if (stored === todayString()) setDismissed(true);
      setReady(true);
    });
  }, []);

  if (!ready) return null;
  if (daysLeft > 10 || daysLeft <= 0) return null; // no banner (expired handled separately)

  const canDismiss = daysLeft >= 4;
  if (canDismiss && dismissed) return null;

  const message = getWarningMessage(daysLeft);
  if (!message) return null;

  const isUrgent = daysLeft <= 3;

  const handleDismiss = async () => {
    await AsyncStorage.setItem(DISMISSED_KEY, todayString());
    setDismissed(true);
  };

  return (
    <View style={[
      bannerStyles.banner,
      isUrgent ? bannerStyles.urgent : bannerStyles.warning,
      { paddingTop: insets.top + 6 },
    ]}>
      <Text style={[bannerStyles.text, isUrgent && bannerStyles.textUrgent]}>
        {message}
      </Text>
      {canDismiss && (
        <TouchableOpacity
          style={bannerStyles.closeBtn}
          onPress={handleDismiss}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          activeOpacity={0.7}
        >
          <Text style={bannerStyles.closeX}>✕</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const bannerStyles = StyleSheet.create({
  banner: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 999,
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingHorizontal: 14,
    paddingBottom: 10,
  },
  warning: { backgroundColor: '#fef3c7' }, // amber-100
  urgent:  { backgroundColor: '#dc2626' }, // red-600
  text: {
    flex: 1,
    fontSize: 13,
    fontWeight: '600',
    color: '#92400e', // amber-800
    lineHeight: 18,
  },
  textUrgent: { color: '#ffffff' },
  closeBtn: {
    marginLeft: 10,
    marginTop: 1,
  },
  closeX: {
    fontSize: 15,
    fontWeight: '700',
    color: '#92400e',
    lineHeight: 18,
  },
});

const blockStyles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#ffffff',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
  },
  logo: {
    width: 220,
    height: 55,
    marginBottom: 32,
  },
  title: {
    fontSize: 24,
    fontWeight: '800',
    color: '#111827',
    textAlign: 'center',
    marginBottom: 16,
  },
  message: {
    fontSize: 16,
    color: '#374151',
    textAlign: 'center',
    lineHeight: 24,
    marginBottom: 32,
  },
  contactCard: {
    backgroundColor: '#f9fafb',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#e5e7eb',
    padding: 20,
    alignItems: 'center',
    width: '100%',
  },
  contactLabel: {
    fontSize: 16,
    fontWeight: '700',
    color: '#111827',
    marginBottom: 12,
  },
  contactRow: {
    paddingVertical: 6,
  },
  contactLink: {
    fontSize: 16,
    fontWeight: '600',
    color: '#16a34a',
    textDecorationLine: 'underline',
  },
});
