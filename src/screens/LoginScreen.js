import React, { useState, useEffect, useRef } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
  SafeAreaView, Image, Alert, ActivityIndicator,
  KeyboardAvoidingView, Platform, ScrollView,
} from 'react-native';
import { auth } from '../config/firebase';
import {
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  sendPasswordResetEmail,
  signInWithCredential,
  GoogleAuthProvider,
} from 'firebase/auth';
import * as Google from 'expo-auth-session/providers/google';
import * as WebBrowser from 'expo-web-browser';
import { Ionicons } from '@expo/vector-icons';
import { colors } from '../theme/colors';

WebBrowser.maybeCompleteAuthSession();

const IOS_CLIENT_ID = '504539802720-durand7v26mrdpiunsmp4tc12qhgmfg9.apps.googleusercontent.com';

export default function LoginScreen() {
  const [mode,        setMode]        = useState('signin'); // 'signin' | 'signup'
  const [email,       setEmail]       = useState('');
  const [password,    setPassword]    = useState('');
  const [confirmPass, setConfirmPass] = useState('');
  const [loading,     setLoading]     = useState(false);
  const [showPass,    setShowPass]    = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);

  const passwordRef    = useRef(null);
  const confirmPassRef = useRef(null);

  const [request, response, promptAsync] = Google.useAuthRequest({
    iosClientId: IOS_CLIENT_ID,
  });

  useEffect(() => {
    if (response?.type === 'success') {
      const { access_token } = response.params;
      if (!access_token) return;
      const credential = GoogleAuthProvider.credential(null, access_token);
      setLoading(true);
      signInWithCredential(auth, credential).catch((err) => {
        Alert.alert('Google Sign-In Failed', err.message);
        setLoading(false);
      });
    } else if (response?.type === 'error') {
      Alert.alert('Google Sign-In Error', response.error?.message || 'Could not complete Google sign-in.');
    }
  }, [response]);

  const handleSignIn = async () => {
    if (!email.trim() || !password) {
      Alert.alert('Required', 'Enter your email and password.');
      return;
    }
    setLoading(true);
    try {
      await signInWithEmailAndPassword(auth, email.trim(), password);
    } catch (err) {
      const msg =
        err.code === 'auth/invalid-credential' || err.code === 'auth/wrong-password'
          ? 'Incorrect email or password.'
          : err.code === 'auth/user-not-found'
          ? 'No account found with that email.'
          : err.code === 'auth/too-many-requests'
          ? 'Too many attempts. Try again later or reset your password.'
          : err.message || 'Sign-in failed.';
      Alert.alert('Sign In Failed', msg);
    } finally {
      setLoading(false);
    }
  };

  const handleSignUp = async () => {
    if (!email.trim() || !password) {
      Alert.alert('Required', 'Enter your email and password.');
      return;
    }
    if (password.length < 6) {
      Alert.alert('Weak Password', 'Password must be at least 6 characters.');
      return;
    }
    if (password !== confirmPass) {
      Alert.alert('Passwords Don\'t Match', 'Please make sure both passwords match.');
      return;
    }
    setLoading(true);
    try {
      await createUserWithEmailAndPassword(auth, email.trim(), password);
    } catch (err) {
      const msg =
        err.code === 'auth/email-already-in-use'
          ? 'An account with this email already exists. Try signing in.'
          : err.code === 'auth/invalid-email'
          ? 'Please enter a valid email address.'
          : err.message || 'Sign-up failed.';
      Alert.alert('Sign Up Failed', msg);
    } finally {
      setLoading(false);
    }
  };

  const handleForgotPassword = () => {
    if (!email.trim()) {
      Alert.alert('Enter Email', 'Type your email address above, then tap Forgot Password.');
      return;
    }
    Alert.alert(
      'Reset Password',
      `Send a password reset link to ${email.trim()}?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Send Link',
          onPress: async () => {
            try {
              await sendPasswordResetEmail(auth, email.trim());
              Alert.alert('Email Sent', 'Check your inbox for a password reset link.');
            } catch (err) {
              Alert.alert('Error', err.message || 'Could not send reset email.');
            }
          },
        },
      ],
    );
  };

  const switchMode = (newMode) => {
    setMode(newMode);
    setPassword('');
    setConfirmPass('');
    setShowPass(false);
    setShowConfirm(false);
  };

  const isSignUp = mode === 'signup';

  return (
    <SafeAreaView style={styles.container}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={styles.inner} keyboardShouldPersistTaps="handled">

          {/* Logo */}
          <View style={styles.logoWrap}>
            <Image source={require('../../assets/Apollonia_new.png')} style={styles.logo} />
            <Text style={styles.tagline}>Field Management</Text>
          </View>

          {/* Mode toggle */}
          <View style={styles.modeToggle}>
            <TouchableOpacity
              style={[styles.modeBtn, !isSignUp && styles.modeBtnActive]}
              onPress={() => switchMode('signin')}
            >
              <Text style={[styles.modeBtnText, !isSignUp && styles.modeBtnTextActive]}>Sign In</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.modeBtn, isSignUp && styles.modeBtnActive]}
              onPress={() => switchMode('signup')}
            >
              <Text style={[styles.modeBtnText, isSignUp && styles.modeBtnTextActive]}>Create Account</Text>
            </TouchableOpacity>
          </View>

          {/* Email */}
          <Text style={styles.label}>EMAIL</Text>
          <View style={styles.inputCard}>
            <Ionicons name="mail-outline" size={18} color={colors.textMuted} style={styles.inputIcon} />
            <TextInput
              style={styles.input}
              value={email}
              onChangeText={setEmail}
              placeholder="your@email.com"
              placeholderTextColor={colors.textMuted}
              keyboardType="email-address"
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="next"
              onSubmitEditing={() => passwordRef.current?.focus()}
            />
          </View>

          {/* Password */}
          <Text style={[styles.label, { marginTop: 14 }]}>PASSWORD</Text>
          <View style={styles.inputCard}>
            <Ionicons name="lock-closed-outline" size={18} color={colors.textMuted} style={styles.inputIcon} />
            <TextInput
              ref={passwordRef}
              style={styles.input}
              value={password}
              onChangeText={setPassword}
              placeholder="Password"
              placeholderTextColor={colors.textMuted}
              secureTextEntry={!showPass}
              returnKeyType={isSignUp ? 'next' : 'done'}
              onSubmitEditing={isSignUp ? () => confirmPassRef.current?.focus() : handleSignIn}
            />
            <TouchableOpacity onPress={() => setShowPass((v) => !v)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <Ionicons name={showPass ? 'eye-off-outline' : 'eye-outline'} size={18} color={colors.textMuted} />
            </TouchableOpacity>
          </View>

          {/* Confirm password (sign up only) */}
          {isSignUp && (
            <>
              <Text style={[styles.label, { marginTop: 14 }]}>CONFIRM PASSWORD</Text>
              <View style={styles.inputCard}>
                <Ionicons name="lock-closed-outline" size={18} color={colors.textMuted} style={styles.inputIcon} />
                <TextInput
                  ref={confirmPassRef}
                  style={styles.input}
                  value={confirmPass}
                  onChangeText={setConfirmPass}
                  placeholder="Re-enter password"
                  placeholderTextColor={colors.textMuted}
                  secureTextEntry={!showConfirm}
                  returnKeyType="done"
                  onSubmitEditing={handleSignUp}
                />
                <TouchableOpacity onPress={() => setShowConfirm((v) => !v)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                  <Ionicons name={showConfirm ? 'eye-off-outline' : 'eye-outline'} size={18} color={colors.textMuted} />
                </TouchableOpacity>
              </View>
            </>
          )}

          {/* Forgot password (sign in only) */}
          {!isSignUp && (
            <TouchableOpacity style={styles.forgotWrap} onPress={handleForgotPassword}>
              <Text style={styles.forgotText}>Forgot Password?</Text>
            </TouchableOpacity>
          )}

          {/* Primary action button */}
          <TouchableOpacity
            style={[styles.primaryBtn, loading && styles.btnDisabled]}
            onPress={isSignUp ? handleSignUp : handleSignIn}
            disabled={loading}
          >
            {loading
              ? <ActivityIndicator color="#fff" size="small" />
              : <Text style={styles.primaryBtnText}>{isSignUp ? 'Create Account' : 'Sign In'}</Text>}
          </TouchableOpacity>

          {/* Divider */}
          <View style={styles.dividerRow}>
            <View style={styles.dividerLine} />
            <Text style={styles.dividerText}>or</Text>
            <View style={styles.dividerLine} />
          </View>

          {/* Google Sign In */}
          <TouchableOpacity
            style={[styles.googleBtn, (!request || loading) && styles.btnDisabled]}
            onPress={() => promptAsync()}
            disabled={!request || loading}
          >
            <Ionicons name="logo-google" size={18} color={colors.textPrimary} />
            <Text style={styles.googleBtnText}>Continue with Google</Text>
          </TouchableOpacity>

          <Text style={styles.hint}>
            Contact kleodiannazeraj@icloud.com for access.
          </Text>

        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f9fafb' },
  inner:     { flexGrow: 1, padding: 28, justifyContent: 'center' },

  logoWrap: { alignItems: 'center', marginBottom: 36 },
  logo:     { width: 240, height: 60, resizeMode: 'contain' },
  tagline:  { fontSize: 13, color: colors.textMuted, marginTop: 8, fontWeight: '500', letterSpacing: 0.5 },

  modeToggle: {
    flexDirection: 'row',
    backgroundColor: '#e5e7eb',
    borderRadius: 10,
    padding: 3,
    marginBottom: 28,
  },
  modeBtn: {
    flex: 1,
    paddingVertical: 9,
    borderRadius: 8,
    alignItems: 'center',
  },
  modeBtnActive: {
    backgroundColor: '#fff',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.1,
    shadowRadius: 3,
    elevation: 2,
  },
  modeBtnText:       { fontSize: 14, fontWeight: '600', color: colors.textMuted },
  modeBtnTextActive: { color: '#16a34a' },

  label: {
    fontSize: 11, fontWeight: '700', color: colors.textMuted,
    letterSpacing: 0.8, marginBottom: 6, marginLeft: 4,
  },

  inputCard: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: '#fff', borderRadius: 12, paddingHorizontal: 14,
    shadowColor: '#000', shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.07, shadowRadius: 4, elevation: 2,
  },
  inputIcon: { marginRight: 10 },
  input: { flex: 1, fontSize: 15, color: colors.textPrimary, paddingVertical: 14 },

  forgotWrap: { alignItems: 'flex-end', marginTop: 10, marginBottom: 4, paddingRight: 4 },
  forgotText: { fontSize: 13, color: '#16a34a', fontWeight: '600' },

  primaryBtn: {
    backgroundColor: '#16a34a',
    borderRadius: 12,
    paddingVertical: 15,
    alignItems: 'center',
    marginTop: 18,
    shadowColor: '#16a34a',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.3,
    shadowRadius: 6,
    elevation: 4,
  },
  btnDisabled:    { opacity: 0.55, shadowOpacity: 0 },
  primaryBtnText: { color: '#fff', fontSize: 16, fontWeight: '700' },

  dividerRow: { flexDirection: 'row', alignItems: 'center', marginVertical: 20, gap: 10 },
  dividerLine: { flex: 1, height: 1, backgroundColor: '#e5e7eb' },
  dividerText: { fontSize: 13, color: colors.textMuted, fontWeight: '500' },

  googleBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10,
    backgroundColor: '#fff', borderRadius: 12, paddingVertical: 14,
    borderWidth: 1, borderColor: '#e5e7eb',
    shadowColor: '#000', shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.07, shadowRadius: 4, elevation: 2,
  },
  googleBtnText: { fontSize: 15, fontWeight: '600', color: colors.textPrimary },

  hint: {
    fontSize: 12, color: colors.textMuted, textAlign: 'center',
    marginTop: 24, lineHeight: 18,
  },
});
