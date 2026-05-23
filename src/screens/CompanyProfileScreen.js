import React, { useState, useEffect, useRef } from 'react';
import {
  View, Text, StyleSheet, SafeAreaView, ScrollView,
  TouchableOpacity, TextInput, Alert, ActivityIndicator,
  Image, Animated, KeyboardAvoidingView, Platform,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import { Asset } from 'expo-asset';
import { getCompanyProfile, saveCompanyProfile } from '../services/db';
import { uploadCompanyLogo } from '../services/storageService';
import { requestPhotoLibraryPermission } from '../utils/permissions';
import { logActivity } from '../services/activityLog';
import { colors } from '../theme/colors';
import AddressAutocomplete from '../components/AddressAutocomplete';

const TAX_FIELDS = [
  { key: 'omaha',       label: 'Omaha',        sub: '5.5% NE state + 1.5% city' },
  { key: 'nebraska',    label: 'Nebraska',     sub: 'outside Omaha' },
  { key: 'iowa',        label: 'Iowa' },
  { key: 'missouri',    label: 'Missouri' },
  { key: 'kansas',      label: 'Kansas' },
  { key: 'southDakota', label: 'South Dakota' },
];

// Legacy hard-coded values from the pre-Company-Profile build. Used to seed
// Firestore the first time this screen opens so the user (and the invoice
// templates) inherit the existing identity instead of starting blank.
// Default tagline applied for any profile without one (legacy seed for new
// installs, and pre-fill for existing profiles when the field is loaded blank).
const DEFAULT_TAGLINE = 'Honest, Reliable, Built Right';

const LEGACY_SEED = {
  companyName:  'Apollonia Construction LLC',
  address:      '2805 S 165th Ave, Omaha, NE 68130',
  phone:        '531-222-6245',
  billingEmail: 'claudioroma999@gmail.com',
  supportEmail: 'kleodiannazeraj@icloud.com',
  tagline:      DEFAULT_TAGLINE,
  taxRates: {
    omaha:       7.0,
    nebraska:    5.5,
    iowa:        0,
    missouri:    0,
    kansas:      0,
    southDakota: 0,
  },
};

export default function CompanyProfileScreen() {
  const navigation = useNavigation();

  const [loading,      setLoading]      = useState(true);
  const [saving,       setSaving]       = useState(false);
  const [uploading,    setUploading]    = useState(false);

  const [companyName,  setCompanyName]  = useState('');
  const [address,      setAddress]      = useState('');
  const [phone,        setPhone]        = useState('');
  const [billingEmail, setBillingEmail] = useState('');
  const [supportEmail, setSupportEmail] = useState('');
  const [tagline,      setTagline]      = useState('');
  const [logoUrl,      setLogoUrl]      = useState('');

  const [taxRates,     setTaxRates]     = useState({
    omaha: '', nebraska: '', iowa: '', missouri: '', kansas: '', southDakota: '',
  });

  const [successMsg,   setSuccessMsg]   = useState('');
  const successOpacity = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    (async () => {
      try {
        let p = await getCompanyProfile();
        // First-open seed: if nothing has been saved yet, populate Firestore
        // with the legacy hard-coded values so invoice templates pick them up
        // immediately and the user sees them pre-filled here.
        if (!p.companyName && !p.address && !p.phone && !p.billingEmail) {
          let seededLogoUrl = '';
          try {
            const [logoAsset] = await Asset.loadAsync(require('../../assets/Apollonia_new.png'));
            if (logoAsset.localUri) {
              seededLogoUrl = await uploadCompanyLogo(logoAsset.localUri);
            }
          } catch (err) {
            console.warn('[CompanyProfile] logo seed upload failed:', err.message);
          }
          await saveCompanyProfile({
            ...LEGACY_SEED,
            logoUrl: seededLogoUrl,
            updatedAt: new Date().toISOString(),
          });
          logActivity('company_profile_seeded', `Company profile seeded with prior defaults${seededLogoUrl ? ' + logo' : ''}`);
          p = await getCompanyProfile();
        }
        setCompanyName(p.companyName || '');
        setAddress(p.address || '');
        setPhone(p.phone || '');
        setBillingEmail(p.billingEmail || '');
        setSupportEmail(p.supportEmail || '');
        // Pre-fill tagline with the default for any existing profile that hasn't
        // saved one yet. User can clear it to render the header without a tagline.
        setTagline(p.tagline != null && p.tagline !== '' ? p.tagline : DEFAULT_TAGLINE);
        setLogoUrl(p.logoUrl || '');
        setTaxRates({
          omaha:       String(p.taxRates?.omaha       ?? ''),
          nebraska:    String(p.taxRates?.nebraska    ?? ''),
          iowa:        String(p.taxRates?.iowa        ?? ''),
          missouri:    String(p.taxRates?.missouri    ?? ''),
          kansas:      String(p.taxRates?.kansas      ?? ''),
          southDakota: String(p.taxRates?.southDakota ?? ''),
        });
      } catch (err) {
        Alert.alert('Error', 'Could not load company profile: ' + err.message);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const showSuccess = (msg) => {
    setSuccessMsg(msg);
    Animated.sequence([
      Animated.timing(successOpacity, { toValue: 1, duration: 200, useNativeDriver: true }),
      Animated.delay(1600),
      Animated.timing(successOpacity, { toValue: 0, duration: 300, useNativeDriver: true }),
    ]).start();
  };

  const handlePickLogo = async () => {
    if (!(await requestPhotoLibraryPermission())) return;
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsMultipleSelection: false,
      quality: 1,
    });
    if (result.canceled || !result.assets?.[0]) return;
    setUploading(true);
    try {
      const url = await uploadCompanyLogo(result.assets[0].uri);
      setLogoUrl(url);
      await saveCompanyProfile({ logoUrl: url });
      logActivity('company_logo_updated', 'Company logo uploaded');
      showSuccess('Logo updated');
    } catch (err) {
      Alert.alert('Upload Failed', err.message || 'Could not upload logo.');
    } finally {
      setUploading(false);
    }
  };

  const handleRemoveLogo = () => {
    Alert.alert('Remove Logo', 'Remove the current company logo? The invoice will fall back to text.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove', style: 'destructive',
        onPress: async () => {
          setLogoUrl('');
          try {
            await saveCompanyProfile({ logoUrl: '' });
            logActivity('company_logo_removed', 'Company logo removed');
          } catch (err) {
            Alert.alert('Error', err.message || 'Could not remove logo.');
          }
        },
      },
    ]);
  };

  const handleSave = async () => {
    if (!companyName.trim()) {
      Alert.alert('Required', 'Company name is required.');
      return;
    }
    setSaving(true);
    try {
      const cleanRates = {};
      for (const { key } of TAX_FIELDS) {
        const v = parseFloat(taxRates[key]);
        cleanRates[key] = isNaN(v) ? 0 : v;
      }
      await saveCompanyProfile({
        companyName:  companyName.trim(),
        address:      address.trim(),
        phone:        phone.trim(),
        billingEmail: billingEmail.trim(),
        supportEmail: supportEmail.trim(),
        tagline:      tagline.trim(),
        taxRates:     cleanRates,
        updatedAt:    new Date().toISOString(),
      });
      logActivity('company_profile_updated', 'Company profile saved');
      showSuccess('Company profile saved');
    } catch (err) {
      Alert.alert('Error', err.message || 'Could not save profile.');
    } finally {
      setSaving(false);
    }
  };

  const updateTaxRate = (key, value) => {
    setTaxRates((prev) => ({ ...prev, [key]: value }));
  };

  if (loading) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.header}>
          <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backBtn}>
            <Ionicons name="chevron-back" size={22} color={colors.primary} />
            <Text style={styles.backText}>Admin</Text>
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Company Profile</Text>
          <View style={{ width: 70 }} />
        </View>
        <ActivityIndicator style={{ marginTop: 60 }} color={colors.primary} />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backBtn}>
          <Ionicons name="chevron-back" size={22} color={colors.primary} />
          <Text style={styles.backText}>Admin</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Company Profile</Text>
        <TouchableOpacity onPress={handleSave} style={styles.saveBtn} disabled={saving}>
          {saving
            ? <ActivityIndicator size="small" color={colors.primary} />
            : <Text style={styles.saveText}>Save</Text>}
        </TouchableOpacity>
      </View>

      <Animated.View style={[styles.successBanner, { opacity: successOpacity }]} pointerEvents="none">
        <Ionicons name="checkmark-circle" size={16} color="#16a34a" />
        <Text style={styles.successText}>{successMsg}</Text>
      </Animated.View>

      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">

          <Text style={styles.hint}>
            Your company identity flows into invoices, PDFs, and email. Tax rates here are used as defaults — you can still override the rate on individual invoices.
          </Text>

          <Text style={styles.sectionLabel}>COMPANY IDENTITY</Text>
          <View style={styles.card}>
            <Field label="COMPANY NAME" value={companyName} onChange={setCompanyName} placeholder="Apollonia Construction LLC" />
            <Divider />
            <View style={styles.fieldWrap}>
              <Text style={styles.fieldLabel}>ADDRESS</Text>
              <AddressAutocomplete
                value={address}
                onChangeText={setAddress}
                placeholder="123 Main St, City, ST 12345"
                flat
              />
            </View>
            <Divider />
            <Field label="PHONE" value={phone} onChange={setPhone} placeholder="555-555-5555" keyboardType="phone-pad" autoCapitalize="none" />
            <Divider />
            <Field label="BILLING EMAIL" value={billingEmail} onChange={setBillingEmail} placeholder="billing@company.com" keyboardType="email-address" autoCapitalize="none" />
            <Divider />
            <Field label="SUPPORT EMAIL" value={supportEmail} onChange={setSupportEmail} placeholder="support@company.com" keyboardType="email-address" autoCapitalize="none" />
            <Divider />
            <Field label="TAGLINE" value={tagline} onChange={setTagline} placeholder="Short slogan shown on invoice header" autoCapitalize="sentences" />
          </View>

          <Text style={styles.sectionLabel}>LOGO</Text>
          <View style={styles.card}>
            <View style={styles.logoPreviewWrap}>
              {logoUrl ? (
                <Image source={{ uri: logoUrl }} style={styles.logoPreview} resizeMode="contain" />
              ) : (
                <View style={styles.logoEmpty}>
                  <Ionicons name="image-outline" size={36} color={colors.textMuted} />
                  <Text style={styles.logoEmptyText}>No logo uploaded</Text>
                </View>
              )}
            </View>
            <View style={styles.logoBtnRow}>
              <TouchableOpacity
                style={[styles.logoBtn, uploading && { opacity: 0.5 }]}
                onPress={handlePickLogo}
                disabled={uploading}
              >
                {uploading
                  ? <ActivityIndicator size="small" color="#fff" />
                  : <>
                      <Ionicons name="cloud-upload-outline" size={16} color="#fff" />
                      <Text style={styles.logoBtnText}>{logoUrl ? 'Replace Logo' : 'Upload Logo'}</Text>
                    </>}
              </TouchableOpacity>
              {logoUrl ? (
                <TouchableOpacity
                  style={styles.logoRemoveBtn}
                  onPress={handleRemoveLogo}
                  disabled={uploading}
                >
                  <Ionicons name="trash-outline" size={16} color="#dc2626" />
                  <Text style={styles.logoRemoveBtnText}>Remove</Text>
                </TouchableOpacity>
              ) : null}
            </View>
            <Text style={styles.logoHint}>
              PNG or JPG. Resized to 600 px wide for use in invoice PDFs.
            </Text>
          </View>

          <Text style={styles.sectionLabel}>TAX RATES (DEFAULT %)</Text>
          <View style={styles.card}>
            {TAX_FIELDS.map(({ key, label, sub }, idx) => (
              <React.Fragment key={key}>
                {idx > 0 && <Divider />}
                <View style={styles.taxRow}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.taxRowLabel}>{label}</Text>
                    {sub ? <Text style={styles.taxRowSub}>{sub}</Text> : null}
                  </View>
                  <View style={styles.taxInputWrap}>
                    <TextInput
                      style={styles.taxInput}
                      value={taxRates[key]}
                      onChangeText={(v) => updateTaxRate(key, v)}
                      keyboardType="decimal-pad"
                      placeholder="0"
                      placeholderTextColor={colors.textMuted}
                      selectTextOnFocus
                    />
                    <Text style={styles.taxPct}>%</Text>
                  </View>
                </View>
              </React.Fragment>
            ))}
          </View>
          <Text style={styles.subHint}>
            These are defaults. You can override the rate on any individual invoice for exceptions.
          </Text>

          <Text style={styles.sectionLabel}>INVOICE NUMBER</Text>
          <View style={styles.card}>
            <View style={styles.invInfoRow}>
              <View style={styles.invInfoIconWrap}>
                <Ionicons name="document-text-outline" size={18} color={colors.primary} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.invInfoTitle}>Auto-generated format</Text>
                <Text style={styles.invInfoCode}>yy-mm-001</Text>
                <Text style={styles.invInfoSub}>
                  Example: 26-05-001 — Sequence resets to 001 at the start of each month. Numbers are guaranteed unique by a Firestore counter.
                </Text>
              </View>
            </View>
          </View>

          <View style={{ height: 40 }} />
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function Field({ label, value, onChange, placeholder, keyboardType, autoCapitalize, multiline }) {
  return (
    <View style={styles.fieldWrap}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        style={[styles.fieldInput, multiline && { minHeight: 48, textAlignVertical: 'top' }]}
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor="#9ca3af"
        keyboardType={keyboardType || 'default'}
        autoCapitalize={autoCapitalize || 'words'}
        multiline={!!multiline}
      />
    </View>
  );
}

function Divider() {
  return <View style={styles.divider} />;
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f9fafb' },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: '#fff',
    borderBottomWidth: 1,
    borderBottomColor: '#e5e7eb',
  },
  backBtn: { flexDirection: 'row', alignItems: 'center', gap: 2, width: 70 },
  backText: { fontSize: 16, color: colors.primary, fontWeight: '500' },
  headerTitle: { flex: 1, fontSize: 17, fontWeight: '700', color: '#111827', textAlign: 'center' },
  saveBtn: { width: 70, alignItems: 'flex-end', paddingRight: 4 },
  saveText: { fontSize: 16, fontWeight: '700', color: colors.primary },

  successBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: '#f0fdf4',
    borderBottomWidth: 1,
    borderBottomColor: '#bbf7d0',
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  successText: { fontSize: 14, fontWeight: '600', color: '#16a34a' },

  content: { padding: 16 },

  hint: {
    fontSize: 13,
    color: colors.textSecondary,
    backgroundColor: '#f0fdf4',
    borderRadius: 10,
    padding: 12,
    marginBottom: 18,
    lineHeight: 19,
    borderWidth: 1,
    borderColor: '#bbf7d0',
  },
  subHint: { fontSize: 12, color: colors.textMuted, marginTop: -10, marginBottom: 18, marginLeft: 4, lineHeight: 17 },

  sectionLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: colors.textMuted,
    letterSpacing: 0.8,
    marginBottom: 8,
    marginTop: 4,
    marginLeft: 4,
  },

  card: {
    backgroundColor: '#fff',
    borderRadius: 14,
    padding: 14,
    marginBottom: 18,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06,
    shadowRadius: 3,
    elevation: 1,
  },

  fieldWrap: { paddingVertical: 8 },
  fieldLabel: {
    fontSize: 10,
    fontWeight: '700',
    color: colors.textMuted,
    letterSpacing: 0.8,
    marginBottom: 5,
  },
  fieldInput: {
    fontSize: 15,
    color: colors.textPrimary,
    paddingVertical: 2,
  },
  divider: { height: 1, backgroundColor: '#f3f4f6', marginVertical: 2 },

  logoPreviewWrap: {
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 14,
  },
  logoPreview: {
    width: '100%',
    height: 100,
    borderRadius: 10,
    backgroundColor: '#f9fafb',
  },
  logoEmpty: {
    width: '100%',
    height: 100,
    borderRadius: 10,
    backgroundColor: '#f9fafb',
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: '#d1d5db',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  logoEmptyText: { fontSize: 12, color: colors.textMuted },
  logoBtnRow: { flexDirection: 'row', gap: 10 },
  logoBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: colors.primary,
    borderRadius: 10,
    paddingVertical: 11,
  },
  logoBtnText: { color: '#fff', fontSize: 14, fontWeight: '700' },
  logoRemoveBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    borderRadius: 10,
    paddingVertical: 11,
    paddingHorizontal: 14,
    borderWidth: 1,
    borderColor: '#fecaca',
    backgroundColor: '#fef2f2',
  },
  logoRemoveBtnText: { color: '#dc2626', fontSize: 13, fontWeight: '600' },
  logoHint: { fontSize: 12, color: colors.textMuted, marginTop: 10, textAlign: 'center' },

  taxRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 10,
  },
  taxRowLabel: { fontSize: 15, fontWeight: '500', color: colors.textPrimary },
  taxRowSub:   { fontSize: 11, color: colors.textMuted, marginTop: 2 },
  taxInputWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#f9fafb',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#e5e7eb',
    paddingHorizontal: 10,
    width: 90,
  },
  taxInput: {
    flex: 1,
    fontSize: 14,
    color: colors.textPrimary,
    paddingVertical: 8,
    textAlign: 'right',
  },
  taxPct: { fontSize: 13, color: colors.textMuted, marginLeft: 4 },

  invInfoRow: { flexDirection: 'row', gap: 12, alignItems: 'flex-start', paddingVertical: 4 },
  invInfoIconWrap: {
    width: 34, height: 34, borderRadius: 8,
    backgroundColor: '#f0fdf4',
    alignItems: 'center', justifyContent: 'center',
  },
  invInfoTitle: { fontSize: 13, fontWeight: '700', color: colors.textPrimary, marginBottom: 4 },
  invInfoCode: {
    fontSize: 16,
    fontWeight: '800',
    color: colors.primary,
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
    letterSpacing: 0.5,
    marginBottom: 6,
  },
  invInfoSub: { fontSize: 12, color: colors.textSecondary, lineHeight: 17 },
});
