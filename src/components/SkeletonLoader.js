import React, { useEffect, useRef } from 'react';
import { View, Animated, StyleSheet } from 'react-native';

export function SkeletonBlock({ width = '100%', height = 20, style }) {
  const anim = useRef(new Animated.Value(0.3)).current;
  useEffect(() => {
    Animated.loop(
      Animated.sequence([
        Animated.timing(anim, { toValue: 1, duration: 800, useNativeDriver: true }),
        Animated.timing(anim, { toValue: 0.3, duration: 800, useNativeDriver: true }),
      ])
    ).start();
  }, []);
  return (
    <Animated.View
      style={[{ width, height, borderRadius: 8, backgroundColor: '#e5e7eb', opacity: anim }, style]}
    />
  );
}

export function SkeletonCard() {
  return (
    <View style={skelStyles.card}>
      <SkeletonBlock width="60%" height={16} style={{ marginBottom: 8 }} />
      <SkeletonBlock width="40%" height={12} style={{ marginBottom: 6 }} />
      <SkeletonBlock width="80%" height={12} />
    </View>
  );
}

const skelStyles = StyleSheet.create({
  card: {
    backgroundColor: '#fff', borderRadius: 12, padding: 14,
    marginBottom: 10, shadowColor: '#000', shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06, shadowRadius: 3, elevation: 2,
  },
});
