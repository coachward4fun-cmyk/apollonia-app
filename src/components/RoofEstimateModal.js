import React from 'react';
import {
  View, Text, StyleSheet, SafeAreaView, ScrollView,
  Modal, TouchableOpacity,
} from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { colors } from '../theme/colors';

// Shared roof-estimate viewer. Used from JobFormScreen (inside the edit form)
// and JobsScreen (via the green Estimate pill on each job card). The parent
// owns all state and side effects via the three callbacks:
//   onClose              — dismiss
//   onDiscard            — caller shows its own confirmation + clears state
//   onApplyToLineItems   — caller updates line items / navigates / etc.
export default function RoofEstimateModal({
  visible,
  roofEstimate,
  aerialPhotoBase64,
  streetViewPhotoBase64,
  jobId,
  onClose,
  onDiscard,
  onApplyToLineItems,
}) {
  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <SafeAreaView style={styles.sheet}>
        <View style={styles.header}>
          <Text style={styles.title}>Roof Estimate</Text>
          <TouchableOpacity onPress={onClose}>
            <Ionicons name="close" size={22} color={colors.textSecondary} />
          </TouchableOpacity>
        </View>
        <ScrollView contentContainerStyle={styles.body}>
          {roofEstimate?.status === 'complete' && (
            <>
              <Text style={styles.squares}>
                {String(roofEstimate.squares)} <Text style={styles.squaresUnit}>squares</Text>
              </Text>
              <Text style={styles.note}>15% factor already applied</Text>

              <View style={styles.metaRow}>
                <View style={styles.metaCell}>
                  <Text style={styles.metaLabel}>Pitch</Text>
                  <Text style={styles.metaValue}>{roofEstimate.pitch}</Text>
                </View>
                <View style={styles.metaCell}>
                  <Text style={styles.metaLabel}>Complexity</Text>
                  <Text style={styles.metaValue}>{roofEstimate.complexity}</Text>
                </View>
              </View>

              {roofEstimate.estimatedAt ? (
                <Text style={styles.meta}>
                  Estimated {new Date(roofEstimate.estimatedAt).toLocaleString('en-US', {
                    month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
                  })}
                </Text>
              ) : null}

              {roofEstimate.reasoning ? (
                <View style={styles.reasoning}>
                  <Text style={styles.reasoningText}>{roofEstimate.reasoning}</Text>
                </View>
              ) : null}

              {aerialPhotoBase64 ? (
                <>
                  <Text style={styles.photoLabel}>Aerial view</Text>
                  <Image
                    source={{ uri: 'data:image/jpeg;base64,' + aerialPhotoBase64 }}
                    style={styles.photo}
                    contentFit="cover"
                  />
                </>
              ) : null}

              {streetViewPhotoBase64 ? (
                <>
                  <Text style={styles.photoLabel}>Street view</Text>
                  <Image
                    source={{ uri: 'data:image/jpeg;base64,' + streetViewPhotoBase64 }}
                    style={styles.photo}
                    contentFit="cover"
                  />
                </>
              ) : null}

              <TouchableOpacity
                style={styles.applyBtn}
                onPress={onApplyToLineItems}
                activeOpacity={0.75}
              >
                <Ionicons name="add-circle-outline" size={18} color="#fff" />
                <Text style={styles.applyBtnText}>Apply to Invoice Line Items</Text>
              </TouchableOpacity>

              <View style={styles.bottomRow}>
                <TouchableOpacity
                  style={[styles.closeBtn, styles.bottomCell]}
                  onPress={onClose}
                  activeOpacity={0.75}
                >
                  <Text style={styles.closeBtnText}>Close</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.discardBtn, styles.bottomCell]}
                  onPress={onDiscard}
                  activeOpacity={0.75}
                >
                  <Text style={styles.discardBtnText}>Discard Estimate</Text>
                </TouchableOpacity>
              </View>
            </>
          )}
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  sheet: { flex: 1, backgroundColor: '#fff' },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingVertical: 14,
    borderBottomWidth: 1, borderBottomColor: '#f3f4f6',
  },
  title: { fontSize: 17, fontWeight: '700', color: colors.textPrimary },
  body: { padding: 20, paddingBottom: 40 },

  squares:     { fontSize: 56, fontWeight: '800', color: colors.primary, textAlign: 'center', marginTop: 8 },
  squaresUnit: { fontSize: 20, fontWeight: '600', color: colors.textSecondary },
  note:        { fontSize: 12, color: colors.textMuted, textAlign: 'center', marginBottom: 18 },

  metaRow:  { flexDirection: 'row', gap: 12, marginBottom: 14 },
  metaCell: {
    flex: 1, backgroundColor: '#f9fafb', borderRadius: 12, padding: 12, alignItems: 'center',
    borderWidth: 1, borderColor: '#e5e7eb',
  },
  metaLabel: { fontSize: 11, fontWeight: '700', color: colors.textMuted, letterSpacing: 0.5 },
  metaValue: { fontSize: 18, fontWeight: '700', color: colors.textPrimary, marginTop: 4 },
  meta:      { fontSize: 12, color: colors.textMuted, textAlign: 'center', marginBottom: 14 },

  reasoning: {
    backgroundColor: '#f0fdf4', borderRadius: 12, padding: 14, marginBottom: 18,
    borderWidth: 1, borderColor: '#bbf7d0',
  },
  reasoningText: { fontSize: 14, color: colors.textPrimary, lineHeight: 20 },

  photoLabel: {
    fontSize: 11, fontWeight: '700', color: colors.textMuted, letterSpacing: 0.5,
    marginBottom: 6, marginTop: 8,
  },
  photo: { width: '100%', aspectRatio: 1, borderRadius: 12, marginBottom: 14 },

  applyBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    backgroundColor: colors.primary, paddingVertical: 14, borderRadius: 12, marginTop: 6,
  },
  applyBtnText: { fontSize: 15, fontWeight: '700', color: '#fff' },

  bottomRow:  { flexDirection: 'row', gap: 10, marginTop: 10 },
  bottomCell: { flex: 1 },

  closeBtn: {
    paddingVertical: 14, borderRadius: 12, alignItems: 'center',
    backgroundColor: '#f3f4f6', borderWidth: 1, borderColor: '#e5e7eb',
  },
  closeBtnText: { fontSize: 15, fontWeight: '700', color: colors.textSecondary },

  discardBtn: {
    paddingVertical: 14, borderRadius: 12, alignItems: 'center',
    backgroundColor: '#dc2626',
  },
  discardBtnText: { fontSize: 15, fontWeight: '700', color: '#fff' },
});
