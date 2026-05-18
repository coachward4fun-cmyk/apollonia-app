import React, { useState, useRef, useCallback } from 'react';
import {
  View, TextInput, TouchableOpacity, Text,
  StyleSheet, ActivityIndicator, Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';

const API_KEY = process.env.EXPO_PUBLIC_GOOGLE_PLACES_KEY;

if (!API_KEY) {
  console.warn('[AddressAutocomplete] EXPO_PUBLIC_GOOGLE_PLACES_KEY is not set — restart the Expo bundler after adding .env');
} else {
  console.log('[AddressAutocomplete] API key loaded, length:', API_KEY.length);
}

// Uses Google Places API (New) — no SDK, pure fetch().
// Biased toward Omaha metro area but accepts any US address.
async function fetchSuggestions(input) {
  if (!API_KEY) {
    console.warn('[AddressAutocomplete] Skipping fetch — API key missing');
    return [];
  }
  if (input.trim().length < 3) return [];
  try {
    const res = await fetch('https://places.googleapis.com/v1/places:autocomplete', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': API_KEY,
        'X-Ios-Bundle-Identifier': 'com.apolloniaconstruction.app',
      },
      body: JSON.stringify({
        input: input.trim(),
        includedPrimaryTypes: ['geocode'],
        locationBias: {
          circle: {
            center: { latitude: 41.2565, longitude: -95.9345 }, // Omaha, NE
            radius: 50000,
          },
        },
      }),
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      console.warn('[AddressAutocomplete] HTTP', res.status, errBody.slice(0, 300));
      return [];
    }
    const data = await res.json();
    console.log('[AddressAutocomplete] Got', (data.suggestions || []).length, 'suggestions for:', input.trim());
    return (data.suggestions || [])
      .filter((s) => s.placePrediction)
      .slice(0, 5)
      .map((s) => ({
        placeId:   s.placePrediction.placeId,
        main:      s.placePrediction.structuredFormat?.mainText?.text
                     ?? s.placePrediction.text?.text ?? '',
        secondary: s.placePrediction.structuredFormat?.secondaryText?.text ?? '',
        full:      s.placePrediction.text?.text ?? '',
      }));
  } catch (err) {
    console.warn('[AddressAutocomplete] fetch error:', err.message);
    return [];
  }
}

// ── Component ──────────────────────────────────────────────────────────────────
//
// Props:
//   value, onChangeText   — controlled input (required)
//   placeholder           — input placeholder text
//   placeholderTextColor  — placeholder color (default #9ca3af)
//   returnKeyType         — keyboard return key (default 'next')
//   flat                  — when true, renders borderless (for screens with their own card)

export default function AddressAutocomplete({
  value,
  onChangeText,
  placeholder = 'Enter address',
  placeholderTextColor = '#9ca3af',
  returnKeyType = 'next',
  flat = false,
}) {
  const [suggestions, setSuggestions] = useState([]);
  const [loading,     setLoading]     = useState(false);
  const debounceRef   = useRef(null);
  const suppressBlur  = useRef(false);

  const handleChangeText = useCallback((text) => {
    onChangeText(text);
    clearTimeout(debounceRef.current);
    if (text.trim().length < 3) { setSuggestions([]); return; }
    debounceRef.current = setTimeout(async () => {
      setLoading(true);
      const results = await fetchSuggestions(text);
      setSuggestions(results);
      setLoading(false);
    }, 350);
  }, [onChangeText]);

  const handleSelect = useCallback((item) => {
    suppressBlur.current = false;
    onChangeText(item.full);
    setSuggestions([]);
  }, [onChangeText]);

  const handleBlur = useCallback(() => {
    if (suppressBlur.current) return;
    // Small delay so onPress on a suggestion can fire before the list disappears
    setTimeout(() => setSuggestions([]), 200);
  }, []);

  const hasSuggestions = suggestions.length > 0;

  return (
    <View style={styles.wrapper}>
      {/* ── Text input ── */}
      <View style={flat ? styles.flatRow : styles.cardRow}>
        <TextInput
          style={flat ? styles.flatInput : styles.cardInput}
          value={value}
          onChangeText={handleChangeText}
          onBlur={handleBlur}
          placeholder={placeholder}
          placeholderTextColor={placeholderTextColor}
          returnKeyType={returnKeyType}
          autoCorrect={false}
          autoCapitalize="words"
          blurOnSubmit={false}
        />
        {loading && (
          <ActivityIndicator size="small" color="#16a34a" style={styles.spinner} />
        )}
      </View>

      {/* ── Suggestions dropdown ── */}
      {hasSuggestions && (
        <View style={styles.dropdown}>
          {suggestions.map((item, i) => (
            <TouchableOpacity
              key={item.placeId}
              style={[styles.row, i < suggestions.length - 1 && styles.rowBorder]}
              onPressIn={() => { suppressBlur.current = true; }}
              onPress={() => handleSelect(item)}
              activeOpacity={0.7}
            >
              <Ionicons name="location-outline" size={14} color="#6b7280" style={styles.pin} />
              <View style={styles.rowTexts}>
                <Text style={styles.mainText} numberOfLines={1}>{item.main}</Text>
                {!!item.secondary && (
                  <Text style={styles.secText} numberOfLines={1}>{item.secondary}</Text>
                )}
              </View>
            </TouchableOpacity>
          ))}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: { zIndex: 100 },

  // Card mode — matches JobFormScreen inputCard
  cardRow: {
    backgroundColor: '#fff',
    borderRadius: 12,
    paddingHorizontal: 16,
    flexDirection: 'row',
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06,
    shadowRadius: 3,
    elevation: 1,
  },
  cardInput: {
    flex: 1,
    fontSize: 14,
    color: '#111827',
    paddingVertical: Platform.OS === 'ios' ? 10 : 7,
  },

  // Flat mode — matches CustomerEditScreen fieldInput (no card, used inside fieldWrap)
  flatRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  flatInput: {
    flex: 1,
    fontSize: 16,
    color: '#111827',
    paddingVertical: 2,
  },

  spinner: { marginLeft: 8 },

  // Suggestions list
  dropdown: {
    marginTop: 4,
    backgroundColor: '#fff',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#e5e7eb',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.12,
    shadowRadius: 8,
    elevation: 8,
    overflow: 'hidden',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 11,
  },
  rowBorder: { borderBottomWidth: 1, borderBottomColor: '#f3f4f6' },
  pin:       { marginRight: 8, flexShrink: 0 },
  rowTexts:  { flex: 1 },
  mainText:  { fontSize: 13, fontWeight: '600', color: '#111827' },
  secText:   { fontSize: 12, color: '#6b7280', marginTop: 1 },
});
