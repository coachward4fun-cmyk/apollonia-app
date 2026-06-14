import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  View, Text, StyleSheet, Modal, TouchableOpacity, ScrollView, KeyboardAvoidingView, Platform, ActivityIndicator, InteractionManager, Animated,
} from 'react-native';
import AppTextInput from './AppTextInput';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAIAssistant } from '../context/AIAssistantContext';
import { useAppData } from '../context/AppDataContext';
import { useAuth } from '../context/AuthContext';
import { sendAIMessage, executeAction, extractFlowFields, VOICE_FLOWS } from '../services/aiService';
import { isOnAdminTab, navigationRef } from '../utils/navigationRef';
import { saveCustomer, saveJob } from '../services/db';
import { logActivity } from '../services/activityLog';
import {
  parseSmartJobIntent, resolveDayHint, matchCustomers, matchJobType,
  formatDateLabel, suggestCustomers,
} from '../utils/smartJobIntent';
import { setAudioModeAsync } from 'expo-audio';

const GREEN = '#16a34a';

// ── Helpers ────────────────────────────────────────────────────────────────────

function resolveCrewId(crewName, crews) {
  if (!crewName) return null;
  const lower = crewName.toLowerCase();
  const match = crews.find((c) => c.name.toLowerCase().includes(lower) || lower.includes(c.name.toLowerCase()));
  return match?.id || null;
}

function isYes(text) {
  return /^(yes|yeah|yep|yup|correct|right|ok|okay|confirm|that'?s?\s+(right|correct)|sounds\s+good|perfect)/i.test(text.trim());
}

function isNo(text) {
  return /^(no|nope|nah|wrong|incorrect|that'?s?\s+(wrong|not\s+right)|not\s+quite|re-?do|retry|again)/i.test(text.trim());
}

// Smart job-create helpers live in src/utils/smartJobIntent.js.

// ── Component ──────────────────────────────────────────────────────────────────

export default function AIAssistantPanel() {
  const {
    isOpen, closePanel,
    isProcessing, setIsProcessing,
    isSpeaking, speakText, stopSpeaking,
    conversation, addMessage, clearConversation,
    pendingVoiceText, clearPendingVoiceText,
    voiceFlow, setVoiceFlow, startVoiceFlow, cancelVoiceFlow, pauseVoiceFlow, resumeVoiceFlow,
    listenStatus,
    startAutoListen, stopAutoListen,
    registerInterimCallback,
    voiceSessionActive,
  } = useAIAssistant();

  const { user }  = useAuth();
  const { crews, jobTypes, activeJobs, customers: contextCustomers } = useAppData();
  const insets    = useSafeAreaInsets();
  const scrollRef = useRef(null);
  const inputRef  = useRef(null);

  const [textInput,      setTextInput]      = useState('');
  const [localPending,   setLocalPending]   = useState(null);
  const [autoListenMode, setAutoListenMode] = useState(null); // null | 'yesno' | 'openended'
  const [listenFallback, setListenFallback] = useState(false);
  // Customer picker shown when smart-create can't match the spoken/typed name.
  // Shape: { customers: [{id, name, ...}], targetDate: 'YYYY-MM-DD' | '' } | null
  const [customerPicker, setCustomerPicker] = useState(null);

  const autoTimeoutRef      = useRef(null);
  const pulseAnim           = useRef(new Animated.Value(1)).current;
  const voiceFlowRef        = useRef(voiceFlow);
  const handleSendRef       = useRef(null);
  const handlePauseFlowRef  = useRef(null);
  const handleConfirmRef    = useRef(null);
  const handleCancelRef     = useRef(null);
  // True while we're listening for a yes/no answer to a Claude-proposed
  // pendingAction during a voice session. handleSend short-circuits to
  // handleConfirm / handleCancel when this is set.
  const awaitingPendingConfirmationRef = useRef(false);
  // Holds the in-progress smart-create prefill while we wait for the user's
  // "anything else to add?" answer. handleSend intercepts the next message
  // when this ref is non-null, parses extra fields, then navigates.
  const smartCreateFollowupRef = useRef(null);
  // Multi-step state for the fully-voice job-create chain (driving / hands-free).
  // Shape: { customer, matchedType, targetDate, step, collected }.
  // When set, handleSend routes each utterance through the conversational
  // address → crew → notes chain and saves directly via saveJob — no form.
  const voiceCreateStateRef = useRef(null);

  // Keep voiceFlowRef current so async callbacks see latest state
  useEffect(() => { voiceFlowRef.current = voiceFlow; }, [voiceFlow]);

  // Pulse animation when auto-listen is active inside panel
  useEffect(() => {
    if (listenStatus === 'listening') {
      const loop = Animated.loop(Animated.sequence([
        Animated.timing(pulseAnim, { toValue: 1.5, duration: 500, useNativeDriver: true }),
        Animated.timing(pulseAnim, { toValue: 1.0, duration: 500, useNativeDriver: true }),
      ]));
      loop.start();
      return () => { loop.stop(); pulseAnim.setValue(1); };
    }
  }, [listenStatus]);

  // Auto-scroll when conversation grows
  useEffect(() => {
    if (conversation.length > 0) {
      setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 100);
    }
  }, [conversation.length, isProcessing]);

  // Reset local state when panel closes
  useEffect(() => {
    if (!isOpen) {
      clearTimeout(autoTimeoutRef.current);
      stopAutoListen();
      setAutoListenMode(null);
      setListenFallback(false);
      setLocalPending(null);
      setCustomerPicker(null);
      setTextInput('');
      awaitingPendingConfirmationRef.current = false;
      smartCreateFollowupRef.current = null;
      voiceCreateStateRef.current = null;
    }
  }, [isOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  // Focus input when panel opens (skip if voice auto-submit will fire)
  useEffect(() => {
    if (isOpen && !pendingVoiceText) {
      setTimeout(() => inputRef.current?.focus(), 400);
    }
  }, [isOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  // When panel opens with an active paused voice flow, prompt to resume
  useEffect(() => {
    if (isOpen && voiceFlow?.paused && conversation.length === 0) {
      const flowDef = VOICE_FLOWS[voiceFlow.type];
      const msg = `Voice flow paused at step ${voiceFlow.step + 1} of ${flowDef.steps.length}. Say "resume" to continue, or use the button above.`;
      addMessage({ role: 'assistant', content: msg });
      console.log('[Panel] → speakText [paused-flow-resume-prompt]');
      speakText(msg);
    }
  }, [isOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Auto-listen core: starts mic with timeout + fallback ─────────────────────
  const activateAutoListen = useCallback((mode) => {
    if (!mode) return;
    setAutoListenMode(mode);
    setListenFallback(false);
    clearTimeout(autoTimeoutRef.current);

    // Register one-shot callback: clears timeout the moment speech recognition
    // detects any audio input (interim result from WebView → FloatingMicButton → context).
    registerInterimCallback(() => {
      console.log('[Speech] User spoke - timeout cleared');
      clearTimeout(autoTimeoutRef.current);
    });

    startAutoListen((result) => {
      clearTimeout(autoTimeoutRef.current);
      setAutoListenMode(null);
      setListenFallback(false);

      if (!result?.trim()) {
        setListenFallback(true);
        if (mode === 'openended') setTimeout(() => inputRef.current?.focus(), 150);
        return;
      }

      const trimmed = result.trim();
      if (/^(pause|stop|switch to manual|manual)/i.test(trimmed)) {
        addMessage({ role: 'user', content: trimmed });
        handlePauseFlowRef.current?.();
        return;
      }
      handleSendRef.current?.(trimmed);
    });

    const timeoutSecs = mode === 'yesno' ? 3 : 8;
    console.log(`[Speech] Mic activated - timeout: ${timeoutSecs}s`);
    autoTimeoutRef.current = setTimeout(() => {
      console.log('[Speech] Timeout expired - showing fallback');
      stopAutoListen();
      setListenFallback(true);
      if (mode === 'openended') setTimeout(() => inputRef.current?.focus(), 150);
    }, timeoutSecs * 1000);
  }, [startAutoListen, stopAutoListen, addMessage, registerInterimCallback]);

  // Retry auto-listen (called from fallback UI)
  const retryAutoListen = useCallback(() => {
    if (autoListenMode) activateAutoListen(autoListenMode);
  }, [autoListenMode, activateAutoListen]);

  // ── speakAndListen: speak then auto-listen ────────────────────────────────────
  // mode: 'yesno' | 'openended' | null (null = speak only, no auto-listen)
  //
  // Primary: onDone callback — mic opens the instant speech truly finishes, so
  // the speech recognizer never grabs the AVAudioSession while TTS is still playing.
  //
  // Fallback timer: fires only if onDone doesn't arrive (known iOS intermittent issue).
  // Uses a generous estimate (words / 2.5 wps + 3 s) so speech is guaranteed complete
  // before the mic opens. The activated flag ensures only one path triggers the mic.
  const speakAndListen = useCallback((text, mode) => {
    stopAutoListen();
    clearTimeout(autoTimeoutRef.current);
    setListenFallback(false);
    if (mode) setAutoListenMode(mode);

    if (!mode) {
      console.log('[Panel] → speakText [speakAndListen.no-mode]');
      speakText(text);
      return;
    }

    const words = text.trim().split(/\s+/).length;
    const fallbackMs = Math.max(5000, (words / 2.5) * 1000 + 3000);

    console.log(`[Speech] Speaking (${words} words, fallback ${(fallbackMs / 1000).toFixed(1)}s): "${text.substring(0, 40)}"`);

    let activated = false;
    const activateOnce = (source) => {
      if (activated) return;
      activated = true;
      clearTimeout(autoTimeoutRef.current);
      if (!voiceFlowRef.current || voiceFlowRef.current.paused) return;
      console.log(`[Speech] Activating mic via ${source}`);
      activateAutoListen(mode);
    };

    console.log('[Panel] → speakText [speakAndListen.main mode=' + mode + ']');
    speakText(text, { onDone: () => activateOnce('onDone') });
    autoTimeoutRef.current = setTimeout(() => activateOnce('fallback-timer'), fallbackMs);
  }, [stopAutoListen, speakText, activateAutoListen]);

  // ── Voice flow: ask current step question ─────────────────────────────────────
  const askFlowQuestion = useCallback((flow) => {
    const flowDef = VOICE_FLOWS[flow.type];
    if (!flowDef) return;
    const step = flowDef.steps[flow.step];
    if (!step) return;
    const msg = step.question;
    addMessage({ role: 'assistant', content: msg });
    console.log('[Panel] → speakAndListen [askFlowQuestion]');
    speakAndListen(msg, 'openended');
  }, [addMessage, speakAndListen]);

  // ── Voice flow: complete ──────────────────────────────────────────────────────
  const completeFlow = useCallback(async (flowType, data) => {
    const crewId = resolveCrewId(data.crewName, crews);

    if (flowType === 'new_job') {
      // Voice session — save directly so we don't interrupt the conversation
      // with a form. Mirrors finishVoiceJobCreate's pattern.
      if (voiceSessionActive) {
        const targetDate = data.targetDate || '';
        const projectName = [
          data.billToName || 'Job',
          data.jobType    || '',
          targetDate      ? formatDateLabel(targetDate) : '',
        ].filter(Boolean).join(' - ');
        const job = {
          id:                 `job_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          projectName,
          jobType:            data.jobType            || '',
          billToName:         data.billToName         || '',
          jobLocationAddress: data.jobLocationAddress || '',
          salesperson:        data.salesperson        || '',
          crewId:             crewId                  || '',
          targetDate,
          status:             targetDate ? 'Scheduled' : 'Not Scheduled',
          createdAt:          new Date().toISOString(),
        };

        cancelVoiceFlow();
        try {
          await saveJob(job);
          logActivity('ai_create_job_voice', `AI voice-created job (legacy flow): ${projectName}`);
          const done = `Done. ${projectName} has been saved.`;
          addMessage({ role: 'assistant', content: done });
          console.log('[Panel] → speakText [completeFlow.new_job.voice-saved]');
          speakText(done);
          setTimeout(() => closePanel(), 1500);
        } catch (err) {
          const failMsg = `Couldn't save the job: ${err.message || 'unknown error'}`;
          addMessage({ role: 'assistant', content: failMsg });
          console.log('[Panel] → speakText [completeFlow.new_job.save-failed]');
          speakText(failMsg);
        }
        return;
      }

      // Typed session — open form pre-filled so the user can review and save.
      const prefill = {
        billToName:         data.billToName  || '',
        jobType:            data.jobType     || '',
        jobLocationAddress: data.jobLocationAddress || '',
        targetDate:         data.targetDate  || '',
        crewId:             crewId           || '',
        salesperson:        data.salesperson || '',
        isNewCustomer:      true,
      };

      const doneMsg = "Great! I've opened the new job form with the details you provided. Review and tap Save.";
      addMessage({ role: 'assistant', content: doneMsg });
      console.log('[Panel] → speakText [completeFlow.new_job.typed-form-opened]');
      speakText(doneMsg);

      cancelVoiceFlow();
      clearConversation();
      // Short delay so speech can start before the modal closes
      setTimeout(() => {
        closePanel();
        InteractionManager.runAfterInteractions(() => {
          navigationRef.navigate('Jobs', { screen: 'JobForm', params: { jobId: null, prefill } });
        });
      }, 800);

    } else if (flowType === 'new_customer') {
      const id  = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const customer = {
        id,
        name:        data.name        || '',
        email:       data.email       || '',
        address:     data.address     || '',
        salesperson: data.salesperson || '',
        updatedAt:   new Date().toISOString(),
      };
      try {
        await saveCustomer(customer);
        const doneMsg = `Customer "${customer.name}" saved successfully.`;
        addMessage({ role: 'assistant', content: doneMsg });
        console.log('[Panel] → speakText [completeFlow.new_customer.saved]');
        speakText(doneMsg);
      } catch (err) {
        addMessage({ role: 'assistant', content: `Error saving customer: ${err.message}` });
      }
      cancelVoiceFlow();

    } else if (flowType === 'edit_job') {
      // For edit_job, the 'changes' field contains a description
      // The AI handled specific field updates via the normal flow
      cancelVoiceFlow();
    }
  }, [crews, addMessage, speakText, cancelVoiceFlow, clearConversation, closePanel, voiceSessionActive]);

  // ── Handle pausing the voice flow ────────────────────────────────────────────
  const handlePauseFlow = useCallback(() => {
    if (!voiceFlow) return;
    stopSpeaking(); // stop AI speech immediately when user pauses
    clearTimeout(autoTimeoutRef.current);
    stopAutoListen();
    pauseVoiceFlow();

    const flowDef  = VOICE_FLOWS[voiceFlow.type];
    const totalSteps = flowDef.steps.length;
    const msg = `Voice flow paused at step ${voiceFlow.step + 1} of ${totalSteps}. You can continue filling the form manually, or tap the assistant again to resume.`;
    addMessage({ role: 'assistant', content: msg });

    // For new_job in a TYPED session: open the form pre-filled with whatever
    // was collected so the user can finish manually. In a VOICE session we
    // never pop the form during the conversation — just close the panel.
    if (voiceFlow.type === 'new_job' && !voiceSessionActive) {
      const crewId = resolveCrewId(voiceFlow.data.crewName, crews);
      const prefill = {
        billToName:         voiceFlow.data.billToName  || '',
        jobType:            voiceFlow.data.jobType     || '',
        jobLocationAddress: voiceFlow.data.jobLocationAddress || '',
        targetDate:         voiceFlow.data.targetDate  || '',
        crewId:             crewId || '',
        salesperson:        voiceFlow.data.salesperson || '',
      };
      setTimeout(() => {
        closePanel();
        InteractionManager.runAfterInteractions(() => {
          navigationRef.navigate('Jobs', { screen: 'JobForm', params: { jobId: null, prefill } });
        });
      }, 600);
    } else {
      closePanel();
    }
  }, [voiceFlow, pauseVoiceFlow, addMessage, crews, closePanel, stopSpeaking, stopAutoListen, voiceSessionActive]);

  // ── Handle resuming the voice flow ───────────────────────────────────────────
  const handleResumeFlow = useCallback(() => {
    resumeVoiceFlow();
    const flowDef = VOICE_FLOWS[voiceFlow.type];
    const step    = flowDef.steps[voiceFlow.step];
    const msg     = `Resuming. ${step.question}`;
    addMessage({ role: 'assistant', content: msg });
    console.log('[Panel] → speakAndListen [handleResumeFlow]');
    speakAndListen(msg, voiceFlow.confirming ? 'yesno' : 'openended');
  }, [voiceFlow, resumeVoiceFlow, addMessage, speakAndListen]);

  // ── Handle voice flow step: extract fields + confirm ─────────────────────────
  const handleFlowStep = useCallback(async (userText) => {
    const flowDef = VOICE_FLOWS[voiceFlow.type];
    const step    = flowDef.steps[voiceFlow.step];

    setIsProcessing(true);
    try {
      const extracted = await extractFlowFields({
        userText,
        fieldsToExtract: step.fields,
        availableCrews:  crews,
        availableJobTypes: jobTypes.map((t) => t.name || t),
        today: new Date().toISOString().slice(0, 10),
      });

      const summary = extracted.summary || userText;
      const { summary: _s, ...fieldData } = extracted;

      // Store extracted data and ask for confirmation
      setVoiceFlow((f) => f ? { ...f, confirming: true, confirmData: fieldData } : f);
      const confirmMsg = `I heard: ${summary}. Is that correct?`;
      addMessage({ role: 'assistant', content: confirmMsg });
      console.log('[Panel] → speakAndListen [handleFlowStep.confirm]');
      speakAndListen(confirmMsg, 'yesno');
    } catch (err) {
      addMessage({ role: 'assistant', content: 'Sorry, I had trouble understanding that. Please try again.' });
    } finally {
      setIsProcessing(false);
    }
  }, [voiceFlow, crews, jobTypes, setIsProcessing, setVoiceFlow, addMessage, speakText]);

  // ── Handle confirmation response (yes/no) ─────────────────────────────────────
  const handleFlowConfirmation = useCallback(async (userText) => {
    if (isYes(userText)) {
      // Merge confirmed data and advance
      const mergedData = { ...voiceFlow.data, ...(voiceFlow.confirmData || {}) };
      const nextStep   = voiceFlow.step + 1;
      const flowDef    = VOICE_FLOWS[voiceFlow.type];

      if (nextStep >= flowDef.steps.length) {
        // All steps done — complete the flow (no auto-listen needed)
        setVoiceFlow((f) => f ? { ...f, step: nextStep, data: mergedData, confirming: false, confirmData: null } : f);
        await completeFlow(voiceFlow.type, mergedData);
      } else {
        // Advance to next step
        const nextStepDef = flowDef.steps[nextStep];
        setVoiceFlow((f) => f ? { ...f, step: nextStep, data: mergedData, confirming: false, confirmData: null } : f);
        addMessage({ role: 'assistant', content: nextStepDef.question });
        console.log('[Panel] → speakAndListen [handleFlowConfirmation.advance]');
        speakAndListen(nextStepDef.question, 'openended');
      }
    } else if (isNo(userText)) {
      // Re-ask the current step
      setVoiceFlow((f) => f ? { ...f, confirming: false, confirmData: null } : f);
      const question = VOICE_FLOWS[voiceFlow.type].steps[voiceFlow.step].question;
      const retry    = `No problem. ${question}`;
      addMessage({ role: 'assistant', content: retry });
      console.log('[Panel] → speakAndListen [handleFlowConfirmation.no-retry]');
      speakAndListen(retry, 'openended');
    } else {
      const clarify = "Sorry, I didn't understand. Please say yes or no.";
      addMessage({ role: 'assistant', content: clarify });
      console.log('[Panel] → speakAndListen [handleFlowConfirmation.clarify]');
      speakAndListen(clarify, 'yesno');
    }
  }, [voiceFlow, setVoiceFlow, addMessage, speakText, completeFlow]);

  // ── Smart job-create: parse hint, match customer, open form ──────────────────

  const navigateToJobFormWithPrefill = useCallback((prefill) => {
    setCustomerPicker(null);
    smartCreateFollowupRef.current = null;
    // Voice session: NEVER open the form. Upstream gating in handleSend and
    // openJobFormWithCustomer should prevent this path; this is defense-in-depth.
    if (voiceSessionActive) {
      const msg = "I couldn't find a customer matching that name. Please add them in the Customers section first, then try again.";
      addMessage({ role: 'assistant', content: msg });
      console.log('[Panel] → speakText [navigateToJobFormWithPrefill.voice-bail]');
      speakText(msg);
      setTimeout(() => closePanel(), 2500);
      return;
    }
    setTimeout(() => {
      closePanel();
      InteractionManager.runAfterInteractions(() => {
        navigationRef.navigate('Jobs', { screen: 'JobForm', params: { jobId: null, prefill } });
      });
    }, 600);
  }, [closePanel, voiceSessionActive, addMessage, speakText]);

  // Speak the "anything else?" follow-up and stash the prefill so handleSend
  // picks the next utterance up as an extension of this smart-create.
  // Voice sessions don't use this path — they go through startVoiceJobCreate.
  const askForExtraDetailsAndNavigate = useCallback((prefill) => {
    if (voiceSessionActive) {
      // Defense-in-depth: voice sessions should never reach here. openJobFormWithCustomer
      // routes voice paths to startVoiceJobCreate. If we land here anyway, bail safely.
      const msg = "I couldn't find a customer matching that name. Please add them in the Customers section first, then try again.";
      addMessage({ role: 'assistant', content: msg });
      console.log('[Panel] → speakText [askForExtraDetailsAndNavigate.voice-bail]');
      speakText(msg);
      setTimeout(() => closePanel(), 2500);
      return;
    }
    smartCreateFollowupRef.current = { prefill };
    const parts = [];
    parts.push(prefill.jobType ? `a ${prefill.jobType} job` : 'a new job');
    if (prefill.billToName) parts.push(`for ${prefill.billToName}`);
    if (prefill.targetDate) parts.push(`on ${formatDateLabel(prefill.targetDate)}`);
    const opener = `Got it — ${parts.join(' ')}. Anything else to add, like the address, crew, or notes?`;
    addMessage({ role: 'assistant', content: opener });
    // Give the message bubble a moment to render before TTS — without this,
    // the bubble mount can interrupt the speak call on slower devices.
    setTimeout(() => {
      console.log('[Panel] → speakAndListen [askForExtraDetailsAndNavigate]');
      speakAndListen(opener, 'openended');
    }, 400);
  }, [addMessage, speakAndListen, voiceSessionActive, speakText, closePanel]);

  // Fully-voice job creation chain — no form, hands-free.
  // Starts after a confident customer match in a voice session. The handleSend
  // intercept walks the user through address → crew → notes, then calls
  // saveJob directly. "done" / "cancel" / "skip" keywords short-circuit any step.
  const startVoiceJobCreate = useCallback((customer, targetDate, matchedType) => {
    voiceCreateStateRef.current = {
      customer,
      matchedType: matchedType || '',
      targetDate:  targetDate  || '',
      step:        'address',
      // Default job-site address to the customer's bill-to address — saying
      // "skip" at the address question naturally keeps this default.
      collected:   { jobLocationAddress: customer?.address || '', crewId: '', notes: '' },
    };
    const typeStr = matchedType ? `${matchedType.toLowerCase()} job` : 'job';
    const dateStr = targetDate  ? ` on ${formatDateLabel(targetDate)}` : '';
    const opener  = `Got it — ${typeStr} for ${customer.name}${dateStr}. What's the job address?`;
    addMessage({ role: 'assistant', content: opener });
    // Let the bubble render before TTS — prevents the speak from being
    // clipped by the conversation list re-render.
    setTimeout(() => {
      console.log('[Panel] → speakAndListen [startVoiceJobCreate]');
      speakAndListen(opener, 'openended');
    }, 400);
  }, [addMessage, speakAndListen]);

  const finishVoiceJobCreate = useCallback(async (state) => {
    voiceCreateStateRef.current = null;
    const { customer, matchedType, targetDate, collected } = state;

    const dateLabel = targetDate ? formatDateLabel(targetDate) : '';
    const projectName = [customer.name, matchedType || 'Job', dateLabel].filter(Boolean).join(' - ');

    const job = {
      id:                 `job_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      projectName,
      jobType:            matchedType || '',
      billToName:         customer.name,
      billToAddress:      customer.address     || '',
      email:              customer.email       || '',
      phone:              customer.phone       || '',
      salesperson:        customer.salesperson || '',
      targetDate:         targetDate || '',
      jobLocationAddress: collected.jobLocationAddress,
      crewId:             collected.crewId,
      notes:              collected.notes,
      status:             targetDate ? 'Scheduled' : 'Not Scheduled',
      createdAt:          new Date().toISOString(),
    };

    try {
      await saveJob(job);
      logActivity('ai_create_job_voice', `AI voice-created job: ${projectName}`);
      const done = `Done. ${projectName} has been saved.`;
      addMessage({ role: 'assistant', content: done });
      console.log('[Panel] → speakText [finishVoiceJobCreate.done]');
      speakText(done);
      setTimeout(() => closePanel(), 1500);
    } catch (err) {
      const failMsg = `Couldn't save the job: ${err.message || 'unknown error'}`;
      addMessage({ role: 'assistant', content: failMsg });
      console.log('[Panel] → speakText [finishVoiceJobCreate.failed]');
      speakText(failMsg);
      // Panel stays open on error so the user can retry or close manually.
    }
  }, [addMessage, speakText, closePanel]);

  // Summary + yes/no confirm step. Either reached at the end of the address →
  // crew → notes chain, or when the user says "done" mid-flow to skip ahead.
  // The handleSend voice-create block handles the yes/no response.
  const goToSummaryStep = useCallback((state) => {
    state.step = 'summary';
    const { customer, matchedType, targetDate, collected } = state;

    const parts = [];
    parts.push(matchedType ? `${matchedType.toLowerCase()} job` : 'job');
    parts.push(`for ${customer.name}`);
    if (targetDate)                   parts.push(`on ${formatDateLabel(targetDate)}`);
    if (collected.jobLocationAddress) parts.push(`at ${collected.jobLocationAddress}`);
    if (collected.crewId) {
      const crew = crews.find((c) => c.id === collected.crewId);
      if (crew) parts.push(`with ${crew.name}`);
    }
    const question = `Okay — ${parts.join(' ')}. Shall I save it?`;
    addMessage({ role: 'assistant', content: question });
    // Render the summary bubble fully before speaking so the user sees the
    // full text on screen as the AI reads it back.
    setTimeout(() => {
      console.log('[Panel] → speakAndListen [voiceCreate.summary]');
      speakAndListen(question, 'yesno');
    }, 400);
  }, [crews, addMessage, speakAndListen]);

  const openJobFormWithCustomer = useCallback((customer, targetDate, jobType) => {
    setCustomerPicker(null);
    // Voice session: NEVER open the form. With a matched customer → conversational
    // voice chain. Without one → bail with a spoken message and close.
    if (voiceSessionActive) {
      if (customer) {
        startVoiceJobCreate(customer, targetDate, jobType);
      } else {
        const msg = "I couldn't find a customer matching that name. Please add them in the Customers section first, then try again.";
        addMessage({ role: 'assistant', content: msg });
        console.log('[Panel] → speakText [openJobFormWithCustomer.voice-bail]');
        speakText(msg);
        setTimeout(() => closePanel(), 2500);
      }
      return;
    }
    // Typed session → existing form flow.
    const prefill = {
      billToName:         customer?.name        || '',
      billToAddress:      customer?.address     || '',
      email:              customer?.email       || '',
      phone:              customer?.phone       || '',
      salesperson:        customer?.salesperson || '',
      // Default job-site address to customer's bill-to. User can override in form.
      jobLocationAddress: customer?.address     || '',
      targetDate:         targetDate            || '',
      jobType:            jobType               || '',
      isExistingCustomer: !!customer,
    };
    askForExtraDetailsAndNavigate(prefill);
  }, [askForExtraDetailsAndNavigate, voiceSessionActive, startVoiceJobCreate, addMessage, speakText, closePanel]);

  const handleSmartCreateJob = useCallback(async ({ typeHint, customer: customerHint, dayHint }) => {
    setIsProcessing(true);
    try {
      const customers   = contextCustomers;
      const targetDate  = resolveDayHint(dayHint);
      const matchedType = matchJobType(typeHint, jobTypes);

      let matched         = null;
      let ambiguousMatches = null; // populated when multiple confident matches exist
      if (customerHint) {
        const matches = matchCustomers(customerHint, customers);
        if (matches.length === 1) {
          matched = matches[0];
        } else if (matches.length > 1) {
          // Multiple confident matches → let the user choose; never silently pick.
          ambiguousMatches = matches;
        }
      }

      // Show picker for either no confident match OR multiple confident matches.
      if (customerHint && !matched) {
        // Voice session can't tap a picker — bail with a spoken message and close.
        if (voiceSessionActive) {
          const msg = "I couldn't find a customer matching that name. Please add them in the Customers section first, then try again.";
          addMessage({ role: 'assistant', content: msg });
          console.log('[Panel] → speakText [handleSmartCreateJob.voice-bail]');
          speakText(msg);
          setTimeout(() => closePanel(), 2500);
          return;
        }
        // Pick the candidate list to show in the picker:
        //   - ambiguous case: the equally-confident matches themselves
        //   - no-match case: top suggestions; fall back to most-recent list if none.
        let candidates;
        let suggestions = [];
        if (ambiguousMatches) {
          candidates = ambiguousMatches.slice(0, 3);
        } else {
          suggestions = suggestCustomers(customerHint, customers, 3);
          if (suggestions.length) {
            candidates = suggestions;
          } else {
            candidates = customers
              .filter((c) => !c.archived && c.name)
              .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''))
              .slice(0, 12);
          }
        }

        // Spoken cap: 2 names max — long lists get fatiguing.
        const spokenNames = candidates.slice(0, 2).map((c) => c.name);
        const writtenNames = candidates.slice(0, 3).map((c) => `"${c.name}"`);
        let msg;
        let spoken;
        if (ambiguousMatches) {
          msg    = `Multiple customers match "${customerHint}". Did you mean ${writtenNames.join(' or ')}? Tap one to use, or close and add a new customer.`;
          spoken = `Multiple customers match ${customerHint}. Did you mean ${spokenNames.join(' or ')}?`;
        } else if (suggestions.length) {
          msg    = `I didn't find a customer matching "${customerHint}". Did you mean ${writtenNames.join(' or ')}? Tap one to use, or close and add a new customer.`;
          spoken = `I didn't find a customer matching ${customerHint}. Did you mean ${spokenNames.join(' or ')}?`;
        } else if (candidates.length) {
          msg    = `I couldn't find a customer matching "${customerHint}". Tap one from the list, or close and add a new customer first.`;
          spoken = `I couldn't find a customer matching ${customerHint}. Please pick one from the list.`;
        } else {
          msg    = `I couldn't find a customer matching "${customerHint}", and there are no customers yet. Close this and add a customer first.`;
          spoken = `I couldn't find a customer matching ${customerHint}. There are no customers yet.`;
        }
        addMessage({ role: 'assistant', content: msg });
        // Render the picker BEFORE speaking — otherwise the picker mount
        // interrupts TTS mid-utterance on slower devices.
        setCustomerPicker({ customers: candidates, targetDate: targetDate || '', jobType: matchedType || '' });
        setTimeout(() => {
          console.log('[Panel] → speakText [handleSmartCreateJob.no-match]');
          speakText(spoken);
        }, 400);
        return;
      }

      // In voice sessions, openJobFormWithCustomer routes to startVoiceJobCreate
      // which speaks its own natural opener. Speaking a typed-flow preamble first
      // ("Opening new job — Finish the rest of the form when ready") is wrong:
      // no form is opening, and the preamble contradicts the conversational chain.
      if (!voiceSessionActive) {
        const parts = [];
        if (matchedType) parts.push(`Type: ${matchedType}`);
        if (matched)     parts.push(`Customer: ${matched.name}`);
        if (targetDate)  parts.push(`Date: ${formatDateLabel(targetDate)}`);
        let summary = parts.length
          ? `Opening new job — ${parts.join(', ')}. Finish the rest of the form when ready.`
          : `Opening new job form.`;
        if (typeHint && !matchedType) {
          summary += ` Job type "${typeHint}" isn't in your list — leaving it blank.`;
        }
        addMessage({ role: 'assistant', content: summary });
        console.log('[Panel] → speakText [handleSmartCreateJob.matched]');
        speakText(summary);
      }

      openJobFormWithCustomer(matched, targetDate, matchedType);
    } catch (err) {
      addMessage({ role: 'assistant', content: `Couldn't load customers: ${err.message}` });
    } finally {
      setIsProcessing(false);
    }
  }, [addMessage, speakText, setIsProcessing, openJobFormWithCustomer, jobTypes, contextCustomers, voiceSessionActive, closePanel]);

  // ── Main send handler ─────────────────────────────────────────────────────────

  const handleSend = useCallback(async (text) => {
    const trimmed = text?.trim();
    if (!trimmed || isProcessing) return;

    // iOS keyboard dictation puts the AVAudioSession into record mode for the
    // duration of the dictation. After it ends, the session stays in record
    // mode until something flips it back, so the AI's TTS response plays
    // silently. Force playback mode here for typed/dictated input — voice
    // sessions already manage the audio session via the mic-tap path, so
    // skip the call there to avoid redundant churn.
    if (!voiceSessionActive) {
      try {
        await setAudioModeAsync({
          playsInSilentMode:      true,
          allowsRecording:        false,
          shouldPlayInBackground: false,
        });
      } catch (e) { /* best-effort; if it fails, TTS may still be muted */ }
    }

    // Cancel any pending auto-listen state before processing
    clearTimeout(autoTimeoutRef.current);
    setAutoListenMode(null);
    setListenFallback(false);
    stopAutoListen();

    setTextInput('');
    addMessage({ role: 'user', content: trimmed });

    // ── Voice confirmation: user is answering yes/no to a pending action ────
    if (awaitingPendingConfirmationRef.current && localPending) {
      awaitingPendingConfirmationRef.current = false;
      if (isYes(trimmed)) {
        handleConfirmRef.current?.();
        return;
      }
      if (isNo(trimmed)) {
        handleCancelRef.current?.();
        return;
      }
      // Anything else → user changed topic; fall through and treat as a new turn.
    }

    // ── Voice job-create chain: address → crew → notes → summary → save ─────
    // Per-step: skip keywords advance without capture; "done" jumps to the
    // summary step (skipping remaining questions); "cancel" aborts entirely.
    // The summary step asks yes/no; only "yes" triggers the actual save.
    if (voiceCreateStateRef.current) {
      const state = voiceCreateStateRef.current;

      // Cancel — abort gracefully and close the panel (works at any step).
      if (/^(cancel|never\s*mind|forget\s+it|stop)\b/i.test(trimmed)) {
        voiceCreateStateRef.current = null;
        addMessage({ role: 'assistant', content: 'Okay, cancelled.' });
        console.log('[Panel] → speakText [handleSend.voiceCreate.cancel]');
        speakText('Okay, cancelled.');
        setTimeout(() => closePanel(), 1500);
        return;
      }

      // Summary step → expect yes/no for the save confirmation.
      if (state.step === 'summary') {
        if (isYes(trimmed)) {
          await finishVoiceJobCreate(state);
          return;
        }
        if (isNo(trimmed)) {
          voiceCreateStateRef.current = null;
          addMessage({ role: 'assistant', content: 'Okay, cancelled.' });
          console.log('[Panel] → speakText [handleSend.voiceCreate.summary-no]');
          speakText('Okay, cancelled.');
          setTimeout(() => closePanel(), 1500);
          return;
        }
        const clarify = "Sorry, I didn't catch that. Shall I save the job? Please say yes or no.";
        addMessage({ role: 'assistant', content: clarify });
        setTimeout(() => {
          console.log('[Panel] → speakAndListen [handleSend.voiceCreate.summary-clarify]');
          speakAndListen(clarify, 'yesno');
        }, 400);
        return;
      }

      // "Done" at any earlier step → skip the rest, jump to summary.
      if (/^(done|that'?s\s+(all|it)|save\s+(it|now)|create\s+(it|now))\b/i.test(trimmed)) {
        goToSummaryStep(state);
        return;
      }

      // Per-step skip vs. capture
      const isSkip = /^(skip|no|none|nothing|nope|nah)\.?\s*$/i.test(trimmed);

      if (state.step === 'address') {
        if (!isSkip) state.collected.jobLocationAddress = trimmed;
        state.step = 'crew';
        const q = 'Which crew?';
        addMessage({ role: 'assistant', content: q });
        setTimeout(() => {
          console.log('[Panel] → speakAndListen [handleSend.voiceCreate.crew-q]');
          speakAndListen(q, 'openended');
        }, 400);
        return;
      }
      if (state.step === 'crew') {
        if (!isSkip) {
          const cid = resolveCrewId(trimmed, crews);
          if (cid) state.collected.crewId = cid;
          // Unrecognized crew name → silently drop and continue.
        }
        state.step = 'notes';
        const q = 'Any notes?';
        addMessage({ role: 'assistant', content: q });
        setTimeout(() => {
          console.log('[Panel] → speakAndListen [handleSend.voiceCreate.notes-q]');
          speakAndListen(q, 'openended');
        }, 400);
        return;
      }
      if (state.step === 'notes') {
        if (!isSkip) state.collected.notes = trimmed;
        goToSummaryStep(state);
        return;
      }
      // Defensive bail: if state.step is somehow unrecognized, swallow the
      // turn rather than fall through to parseSmartJobIntent and pop the form.
      return;
    }

    // ── Smart-create follow-up: user is answering "anything else to add?" ───
    // Voice sessions never reach the form-opening followup — gate it explicitly.
    if (smartCreateFollowupRef.current && !voiceSessionActive) {
      const { prefill: pendingPrefill } = smartCreateFollowupRef.current;
      smartCreateFollowupRef.current = null;

      // Whole-message negation → navigate straight away.
      if (/^(no|nothing|that'?s\s+it|skip|done|nope|nah|all\s+good)\.?\s*$/i.test(trimmed)) {
        const msg = 'Okay, opening the form.';
        addMessage({ role: 'assistant', content: msg });
        console.log('[Panel] → speakText [handleSend.smartFollowup.negate]');
        speakText(msg);
        navigateToJobFormWithPrefill(pendingPrefill);
        return;
      }

      // Otherwise → let Claude parse the answer into additional fields.
      setIsProcessing(true);
      try {
        const today = new Date().toISOString().slice(0, 10);
        const jobTypeNames = (jobTypes || [])
          .map((t) => (typeof t === 'string' ? t : t?.name))
          .filter(Boolean);
        const extracted = await extractFlowFields({
          userText:          trimmed,
          fieldsToExtract:   ['jobLocationAddress', 'crewName', 'salesperson', 'notes', 'billToName', 'targetDate', 'jobType'],
          availableCrews:    crews,
          availableJobTypes: jobTypeNames,
          today,
        });

        const merged = { ...pendingPrefill };
        if (extracted.jobLocationAddress) merged.jobLocationAddress = extracted.jobLocationAddress;
        if (extracted.salesperson)        merged.salesperson        = extracted.salesperson;
        if (extracted.notes)              merged.notes              = extracted.notes;
        if (extracted.billToName)         merged.billToName         = extracted.billToName;
        if (extracted.targetDate)         merged.targetDate         = extracted.targetDate;
        if (extracted.jobType)            merged.jobType            = extracted.jobType;
        if (extracted.crewName) {
          const cid = resolveCrewId(extracted.crewName, crews);
          if (cid) merged.crewId = cid;
        }

        const summary = extracted.summary
          ? `${extracted.summary} Opening the form.`
          : 'Got it, opening the form.';
        addMessage({ role: 'assistant', content: summary });
        console.log('[Panel] → speakText [handleSend.smartFollowup.parsed]');
        speakText(summary);
        navigateToJobFormWithPrefill(merged);
      } catch (err) {
        addMessage({ role: 'assistant', content: 'Trouble parsing that — opening the form with what we have.' });
        navigateToJobFormWithPrefill(pendingPrefill);
      } finally {
        setIsProcessing(false);
      }
      return;
    }

    // ── Smart job-create fast path ───────────────────────────────────────────
    // "New Job for Shamrock on Thursday" → resolve customer + date locally and
    // open the form. We only intercept when at least one hint is parseable;
    // a bare "new job" falls through to the existing voice-flow trigger.
    //
    // Critical: voiceCreateStateRef.current must NOT be set here — otherwise a
    // user's mid-flow answer that incidentally contains words like "roof" or
    // "for" can re-trigger smart-create and pop the form. The voice-create
    // intercept block above already returns, but we keep this guard as
    // defense-in-depth so nothing interrupts an active voice job conversation.
    if (!voiceFlow && !customerPicker && !voiceCreateStateRef.current) {
      const intent = parseSmartJobIntent(trimmed);
      if (intent && (intent.customer || intent.dayHint)) {
        await handleSmartCreateJob(intent);
        return;
      }
    }

    // ── Resume paused flow ───────────────────────────────────────────────────
    if (voiceFlow?.paused && /^resume/i.test(trimmed)) {
      handleResumeFlow();
      return;
    }

    // ── Active voice flow ────────────────────────────────────────────────────
    if (voiceFlow && !voiceFlow.paused) {
      const lower = trimmed.toLowerCase();

      // Allow user to pause via text
      if (/^(pause|stop|switch to manual|manual)/i.test(lower)) {
        handlePauseFlow();
        return;
      }

      if (voiceFlow.confirming) {
        await handleFlowConfirmation(trimmed);
      } else {
        await handleFlowStep(trimmed);
      }
      return;
    }

    // ── Normal AI flow ───────────────────────────────────────────────────────
    setIsProcessing(true);

    const adminScreen = isOnAdminTab();
    const userName    = user?.displayName || user?.email || 'User';

    const history = [...conversation, { role: 'user', content: trimmed }].map((m) => ({
      role:    m.role === 'user' ? 'user' : 'assistant',
      content: m.content,
    }));

    try {
      const result = await sendAIMessage(history, adminScreen, userName, { jobs: activeJobs, crews });

      // START_VOICE_FLOW is handled immediately without YES/NO
      if (result.pendingAction?.type === 'START_VOICE_FLOW') {
        const { flowType } = result.pendingAction.data || {};
        if (flowType && VOICE_FLOWS[flowType]) {
          addMessage({ role: 'assistant', content: result.message, isCommand: false });
          console.log('[Panel] → speakText [handleSend.AI.start-voice-flow]');
          speakText(result.message);
          startVoiceFlow(flowType);
          // Give the spoken intro a moment, then ask first question with auto-listen
          setTimeout(() => {
            const firstQ = VOICE_FLOWS[flowType].steps[0].question;
            addMessage({ role: 'assistant', content: firstQ });
            console.log('[Panel] → speakAndListen [handleSend.AI.first-question]');
            speakAndListen(firstQ, 'openended');
          }, 1800);
        }
        setIsProcessing(false);
        return;
      }

      const isCommand = !!result.pendingAction;
      addMessage({ role: 'assistant', content: result.message, isCommand });

      if (result.pendingAction) {
        setLocalPending(result.pendingAction);
      }

      if (isCommand && voiceSessionActive) {
        // Voice-tap session: speak the proposal then auto-listen for yes/no.
        // The Confirm/Cancel buttons stay visible as a fallback.
        awaitingPendingConfirmationRef.current = true;
        console.log('[Panel] → speakAndListen [handleSend.AI.command-confirm]');
        speakAndListen(result.message, 'yesno');
      } else if (!isCommand) {
        console.log('[Panel] → speakText [handleSend.AI.reply]');
        speakText(result.message);
      }
    } catch (err) {
      const isKeyErr = err.message?.includes('YOUR_KEY_HERE') || err.message?.includes('401');
      addMessage({
        role:    'assistant',
        content: isKeyErr
          ? 'API key not set. Add your Anthropic key to src/config/anthropic.js.'
          : 'Sorry, I had trouble connecting. Please try again.',
      });
    } finally {
      setIsProcessing(false);
    }
  }, [
    isProcessing, conversation, addMessage, speakText, speakAndListen, user,
    voiceFlow, handlePauseFlow, handleResumeFlow, handleFlowStep, handleFlowConfirmation,
    startVoiceFlow, setIsProcessing, stopAutoListen,
    customerPicker, handleSmartCreateJob,
    activeJobs, crews, jobTypes,
    voiceSessionActive, localPending, navigateToJobFormWithPrefill,
    finishVoiceJobCreate, goToSummaryStep, closePanel,
  ]);

  // Auto-submit voice transcript when panel opens
  useEffect(() => {
    if (!isOpen || !pendingVoiceText || isProcessing) return;
    const text = pendingVoiceText;
    clearPendingVoiceText();
    const timer = setTimeout(() => handleSend(text), 350);
    return () => clearTimeout(timer);
  }, [isOpen, pendingVoiceText]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Confirm / cancel pending action ──────────────────────────────────────────

  const handleConfirm = useCallback(async () => {
    if (!localPending) return;
    const action = localPending;
    setLocalPending(null);
    setIsProcessing(true);
    try {
      const result = await executeAction(action);
      addMessage({ role: 'assistant', content: result });
      console.log('[Panel] → speakText [handleConfirm.action-result]');
      speakText(result);
    } catch (err) {
      addMessage({ role: 'assistant', content: `Action failed: ${err.message}` });
    } finally {
      setIsProcessing(false);
    }
  }, [localPending, addMessage, speakText]);

  const handleCancel = useCallback(() => {
    setLocalPending(null);
    const msg = 'Action cancelled.';
    addMessage({ role: 'assistant', content: msg });
    console.log('[Panel] → speakText [handleCancel.cancelled]');
    speakText(msg);
  }, [addMessage, speakText]);

  // ── Close ─────────────────────────────────────────────────────────────────────
  // X always fully terminates: cancel any voice flow (active or paused), clear the
  // conversation, and close the panel. No pausing, no confirmation, no navigation.

  const handleClose = useCallback(() => {
    console.log('[Panel] X tapped - terminating voice flow and closing panel');
    clearTimeout(autoTimeoutRef.current);
    stopAutoListen();
    setAutoListenMode(null);
    setListenFallback(false);
    setLocalPending(null);
    cancelVoiceFlow();
    clearConversation();
    closePanel();
  }, [cancelVoiceFlow, clearConversation, closePanel, stopAutoListen]);

  // Stable callback fed to memoized Bubble components — prevents the whole
  // conversation list from re-rendering each time a new message is appended.
  const handleSpeakContent = useCallback((content) => {
    console.log('[Panel] → speakText [handleSpeakContent.bubble-tap]');
    speakText(content);
  }, [speakText]);

  // iOS keyboard dictation doubling is handled by AppTextInput's shared guard
  // (see src/components/AppTextInput.js); the input below wires straight to
  // setTextInput.

  // Keep refs current so async auto-listen callbacks see latest closures
  handleSendRef.current      = handleSend;
  handlePauseFlowRef.current = handlePauseFlow;
  handleConfirmRef.current   = handleConfirm;
  handleCancelRef.current    = handleCancel;

  // ── Render ────────────────────────────────────────────────────────────────────

  const flowDef      = voiceFlow ? VOICE_FLOWS[voiceFlow.type] : null;
  const totalSteps   = flowDef ? flowDef.steps.length : 0;

  return (
    <Modal
      visible={isOpen}
      animationType="slide"
      presentationStyle="overFullScreen"
      transparent
      statusBarTranslucent
      onRequestClose={handleClose}
    >
      <KeyboardAvoidingView
        style={styles.overlay}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        {/* Tap backdrop to close */}
        <TouchableOpacity style={styles.backdrop} activeOpacity={1} onPress={handleClose} />

        <View style={[styles.panel, { paddingBottom: Math.max(insets.bottom, 12) }]}>
          {/* Drag handle */}
          <View style={styles.handle} />

          {/* Header */}
          <View style={styles.header}>
            <View style={styles.headerLeft}>
              <View style={styles.badge}>
                <Ionicons name="sparkles" size={14} color="#fff" />
              </View>
              <Text style={styles.headerTitle}>Apollonia Assistant</Text>
            </View>
            <TouchableOpacity onPress={handleClose} hitSlop={{ top: 14, bottom: 14, left: 14, right: 14 }}>
              <Ionicons name="close-circle" size={26} color="#9ca3af" />
            </TouchableOpacity>
          </View>

          {/* Voice flow banner */}
          {voiceFlow && flowDef && (
            <View style={[styles.flowBanner, voiceFlow.paused && styles.flowBannerPaused]}>
              <View style={styles.flowBannerLeft}>
                <Ionicons
                  name={voiceFlow.paused ? 'pause-circle' : 'mic'}
                  size={16}
                  color={voiceFlow.paused ? '#d97706' : GREEN}
                />
                <View style={{ marginLeft: 8 }}>
                  <Text style={[styles.flowBannerTitle, voiceFlow.paused && { color: '#d97706' }]}>
                    {voiceFlow.paused ? 'Voice Flow Paused' : flowDef.label}
                  </Text>
                  <Text style={styles.flowBannerSub}>
                    Step {voiceFlow.step + 1} of {totalSteps}
                  </Text>
                </View>
              </View>
              {voiceFlow.paused ? (
                <TouchableOpacity style={[styles.flowBannerBtn, styles.flowBannerBtnResume]} onPress={handleResumeFlow}>
                  <Ionicons name="play" size={13} color={GREEN} />
                  <Text style={[styles.flowBannerBtnText, { color: GREEN }]}>Resume</Text>
                </TouchableOpacity>
              ) : (
                <TouchableOpacity style={[styles.flowBannerBtn, styles.flowBannerBtnPause]} onPress={handlePauseFlow}>
                  <Ionicons name="pause" size={13} color="#92400e" />
                  <Text style={[styles.flowBannerBtnText, { color: '#92400e' }]}>Pause / Manual</Text>
                </TouchableOpacity>
              )}
            </View>
          )}

          {/* Conversation */}
          <ScrollView
            ref={scrollRef}
            style={styles.scroll}
            contentContainerStyle={styles.scrollContent}
            showsVerticalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
          >
            {conversation.length === 0 && !voiceFlow && (
              <View style={styles.empty}>
                <Ionicons name="chatbubble-ellipses-outline" size={44} color={GREEN} style={{ opacity: 0.35 }} />
                <Text style={styles.emptyTitle}>Ask me anything</Text>
                <Text style={styles.emptyBody}>
                  Type a question or say "create a new job" to start a guided voice flow. Use the{' '}
                  <Text style={{ fontWeight: '700' }}>🎤</Text> on your keyboard to speak.
                </Text>
              </View>
            )}

            {conversation.map((msg, i) => (
              <Bubble
                key={i}
                msg={msg}
                onSpeak={handleSpeakContent}
                isSpeaking={isSpeaking}
              />
            ))}

            {isProcessing && (
              <View style={styles.thinkRow}>
                <ActivityIndicator size="small" color={GREEN} />
                <Text style={styles.thinkText}>
                  {voiceFlow && !voiceFlow.paused ? 'Extracting…' : 'Thinking…'}
                </Text>
              </View>
            )}
          </ScrollView>

          {/* Auto-listen status + fallback — only shown during active voice flow */}
          {voiceFlow && !voiceFlow.paused && !localPending && (listenStatus !== 'idle' || listenFallback) && (
            <View style={styles.listenArea}>
              {listenFallback ? (
                <>
                  <Text style={styles.listenFallbackMsg}>
                    I didn't hear you — {autoListenMode === 'yesno' ? 'tap Yes or No' : 'type your response or try again'}
                  </Text>
                  {autoListenMode === 'yesno' && (
                    <View style={styles.listenYesNoRow}>
                      <TouchableOpacity
                        style={[styles.listenBtn, { backgroundColor: GREEN }]}
                        onPress={() => { setListenFallback(false); handleSend('yes'); }}
                      >
                        <Text style={styles.listenBtnText}>Yes</Text>
                      </TouchableOpacity>
                      <TouchableOpacity
                        style={[styles.listenBtn, { backgroundColor: '#dc2626' }]}
                        onPress={() => { setListenFallback(false); handleSend('no'); }}
                      >
                        <Text style={styles.listenBtnText}>No</Text>
                      </TouchableOpacity>
                    </View>
                  )}
                  <TouchableOpacity style={styles.retryMicBtn} onPress={retryAutoListen}>
                    <Ionicons name="mic-outline" size={15} color={GREEN} />
                    <Text style={styles.retryMicText}>Try again</Text>
                  </TouchableOpacity>
                </>
              ) : listenStatus === 'waiting' ? (
                <Text style={styles.listenWaiting}>· · ·</Text>
              ) : (
                <View style={styles.listeningRow}>
                  <Animated.View style={[styles.listenDot, { transform: [{ scale: pulseAnim }] }]} />
                  <Text style={styles.listeningText}>Listening…</Text>
                </View>
              )}
            </View>
          )}

          {/* Customer picker — shown when smart-create can't find a match */}
          {!!customerPicker && (
            <View style={styles.pickerBox}>
              <Text style={styles.pickerLabel}>
                Pick a customer
                {customerPicker.jobType    ? ` · ${customerPicker.jobType}` : ''}
                {customerPicker.targetDate ? ` · ${formatDateLabel(customerPicker.targetDate)}` : ''}
              </Text>
              <ScrollView style={styles.pickerScroll} contentContainerStyle={styles.pickerChipsWrap} showsVerticalScrollIndicator={false}>
                {customerPicker.customers.length === 0 ? (
                  <Text style={styles.pickerEmpty}>No customers found.</Text>
                ) : (
                  customerPicker.customers.map((c) => (
                    <TouchableOpacity
                      key={c.id || c.name}
                      style={styles.pickerChip}
                      onPress={() => openJobFormWithCustomer(c, customerPicker.targetDate, customerPicker.jobType)}
                      activeOpacity={0.75}
                    >
                      <Text style={styles.pickerChipText} numberOfLines={1}>{c.name}</Text>
                    </TouchableOpacity>
                  ))
                )}
              </ScrollView>
              <TouchableOpacity style={styles.pickerCancel} onPress={() => setCustomerPicker(null)}>
                <Text style={styles.pickerCancelText}>Cancel</Text>
              </TouchableOpacity>
            </View>
          )}

          {/* YES / NO confirmation panel */}
          {!!localPending && (
            <View style={styles.confirmBox}>
              <Text style={styles.confirmDesc} numberOfLines={3}>
                {localPending.description}
              </Text>
              <View style={styles.confirmBtns}>
                <TouchableOpacity style={[styles.confirmBtn, { backgroundColor: GREEN }]} onPress={handleConfirm}>
                  <Text style={styles.confirmBtnText}>YES — Confirm</Text>
                </TouchableOpacity>
                <TouchableOpacity style={[styles.confirmBtn, { backgroundColor: '#dc2626' }]} onPress={handleCancel}>
                  <Text style={styles.confirmBtnText}>NO — Cancel</Text>
                </TouchableOpacity>
              </View>
            </View>
          )}

          {/* Input row */}
          <View style={styles.inputRow}>
            <AppTextInput
              ref={inputRef}
              style={styles.input}
              placeholder={
                voiceFlow && !voiceFlow.paused
                  ? (voiceFlow.confirming ? "Say 'yes' or 'no'…" : "Speak or type your answer…")
                  : listenStatus === 'listening'
                    ? 'Listening…'
                    : 'Tap the mic to speak, or type here'
              }
              placeholderTextColor="#9ca3af"
              value={textInput}
              onChangeText={setTextInput}
              onSubmitEditing={() => handleSend(textInput)}
              returnKeyType="send"
              multiline={false}
              editable={!isProcessing}
            />
            <TouchableOpacity
              style={[styles.sendBtn, (!textInput.trim() || isProcessing) && styles.sendBtnOff]}
              onPress={() => handleSend(textInput)}
              disabled={!textInput.trim() || isProcessing}
              activeOpacity={0.8}
            >
              <Ionicons name="send" size={19} color="#fff" />
            </TouchableOpacity>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

// ── Conversation bubble ───────────────────────────────────────────────────────
// Memoized so appending a new message doesn't re-render the full list.
// Relies on a stable onSpeak callback from the parent (handleSpeakContent).

const Bubble = React.memo(function Bubble({ msg, onSpeak, isSpeaking }) {
  const isUser = msg.role === 'user';
  return (
    <View style={[styles.bubbleWrap, isUser ? styles.bubbleWrapRight : styles.bubbleWrapLeft]}>
      {!isUser && (
        <View style={styles.aiBadge}>
          <Ionicons name="sparkles" size={11} color="#fff" />
        </View>
      )}
      <View style={[styles.bubble, isUser ? styles.bubbleUser : styles.bubbleAI]}>
        <Text style={[styles.bubbleText, isUser ? styles.bubbleTextUser : styles.bubbleTextAI]}>
          {msg.content}
        </Text>
        {!isUser && msg.isCommand && (
          <TouchableOpacity style={styles.speakerBtn} onPress={() => onSpeak(msg.content)}>
            <Ionicons
              name={isSpeaking ? 'volume-high' : 'volume-medium-outline'}
              size={16}
              color={GREEN}
            />
          </TouchableOpacity>
        )}
      </View>
    </View>
  );
});

const styles = StyleSheet.create({
  overlay:  { flex: 1, justifyContent: 'flex-end' },
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.45)' },

  panel: {
    backgroundColor: '#fff',
    borderTopLeftRadius: 26,
    borderTopRightRadius: 26,
    maxHeight: '88%',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: -5 },
    shadowOpacity: 0.16,
    shadowRadius: 12,
    elevation: 22,
  },
  handle: {
    alignSelf: 'center',
    width: 40, height: 4,
    borderRadius: 2,
    backgroundColor: '#e5e7eb',
    marginTop: 10, marginBottom: 4,
  },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 18,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#f3f4f6',
  },
  headerLeft:  { flexDirection: 'row', alignItems: 'center', gap: 10 },
  badge: {
    width: 28, height: 28, borderRadius: 14,
    backgroundColor: GREEN,
    alignItems: 'center', justifyContent: 'center',
  },
  headerTitle: { fontSize: 16, fontWeight: '700', color: '#111827' },

  // Voice flow banner
  flowBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingVertical: 10,
    backgroundColor: '#f0fdf4',
    borderBottomWidth: 1,
    borderBottomColor: '#bbf7d0',
  },
  flowBannerPaused: {
    backgroundColor: '#fffbeb',
    borderBottomColor: '#fde68a',
  },
  flowBannerLeft:  { flexDirection: 'row', alignItems: 'center' },
  flowBannerTitle: { fontSize: 13, fontWeight: '700', color: '#166534' },
  flowBannerSub:   { fontSize: 11, color: '#4b7c5a', marginTop: 1 },
  flowBannerBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
    borderWidth: 1,
  },
  flowBannerBtnPause:  { borderColor: '#d97706', backgroundColor: '#fef3c7' },
  flowBannerBtnResume: { borderColor: GREEN,     backgroundColor: '#f0fdf4' },
  flowBannerBtnText:   { fontSize: 12, fontWeight: '700' },

  scroll:        { maxHeight: 400 },
  scrollContent: { padding: 16, gap: 10, flexGrow: 1 },

  empty: {
    alignItems: 'center',
    paddingVertical: 40,
    paddingHorizontal: 28,
    gap: 10,
  },
  emptyTitle: { fontSize: 15, fontWeight: '700', color: '#374151' },
  emptyBody:  { fontSize: 13, color: '#6b7280', textAlign: 'center', lineHeight: 19 },

  bubbleWrap:      { flexDirection: 'row', alignItems: 'flex-end', gap: 6 },
  bubbleWrapRight: { justifyContent: 'flex-end' },
  bubbleWrapLeft:  { justifyContent: 'flex-start' },
  aiBadge: {
    width: 24, height: 24, borderRadius: 12,
    backgroundColor: GREEN,
    alignItems: 'center', justifyContent: 'center',
    flexShrink: 0, marginBottom: 2,
  },
  bubble:         { maxWidth: '78%', borderRadius: 18, paddingHorizontal: 13, paddingVertical: 9 },
  bubbleUser:     { backgroundColor: GREEN, borderBottomRightRadius: 4 },
  bubbleAI:       { backgroundColor: '#f3f4f6', borderBottomLeftRadius: 4 },
  bubbleText:     { fontSize: 14, lineHeight: 20 },
  bubbleTextUser: { color: '#fff' },
  bubbleTextAI:   { color: '#111827' },
  speakerBtn:     { alignSelf: 'flex-end', marginTop: 5 },

  thinkRow: {
    flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 4,
  },
  thinkText: { fontSize: 13, color: '#9ca3af', fontStyle: 'italic' },

  // Auto-listen area
  listenArea: {
    borderTopWidth: 1,
    borderTopColor: '#f0fdf4',
    backgroundColor: '#f9fffe',
    paddingHorizontal: 16,
    paddingVertical: 10,
    alignItems: 'center',
    gap: 8,
  },
  listenWaiting: {
    fontSize: 20,
    color: GREEN,
    letterSpacing: 4,
    fontWeight: '700',
  },
  listeningRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  listenDot: {
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: GREEN,
  },
  listeningText: {
    fontSize: 14,
    color: GREEN,
    fontWeight: '700',
  },
  listenFallbackMsg: {
    fontSize: 13,
    color: '#6b7280',
    textAlign: 'center',
  },
  listenYesNoRow: {
    flexDirection: 'row',
    gap: 12,
  },
  listenBtn: {
    flex: 1,
    paddingVertical: 11,
    borderRadius: 12,
    alignItems: 'center',
    minWidth: 80,
  },
  listenBtnText: {
    color: '#fff',
    fontWeight: '800',
    fontSize: 15,
  },
  retryMicBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: GREEN,
  },
  retryMicText: {
    fontSize: 13,
    color: GREEN,
    fontWeight: '600',
  },

  pickerBox: {
    borderTopWidth: 1,
    borderTopColor: '#f3f4f6',
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 6,
    gap: 8,
  },
  pickerLabel: {
    fontSize: 12,
    fontWeight: '700',
    color: '#374151',
    letterSpacing: 0.4,
    textTransform: 'uppercase',
  },
  pickerScroll: { maxHeight: 160 },
  pickerChipsWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  pickerChip: {
    backgroundColor: '#f0fdf4',
    borderColor: '#bbf7d0',
    borderWidth: 1,
    borderRadius: 16,
    paddingHorizontal: 12,
    paddingVertical: 7,
    maxWidth: '100%',
  },
  pickerChipText: { fontSize: 13, fontWeight: '600', color: GREEN },
  pickerEmpty:    { fontSize: 13, color: '#6b7280', paddingVertical: 4 },
  pickerCancel: {
    alignSelf: 'flex-end',
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  pickerCancelText: { fontSize: 13, fontWeight: '600', color: '#6b7280' },

  confirmBox: {
    borderTopWidth: 1,
    borderTopColor: '#f3f4f6',
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 6,
    gap: 8,
  },
  confirmDesc:    { fontSize: 13, fontWeight: '600', color: '#374151', textAlign: 'center' },
  confirmBtns:    { flexDirection: 'row', gap: 10 },
  confirmBtn:     { flex: 1, paddingVertical: 13, borderRadius: 13, alignItems: 'center' },
  confirmBtnText: { color: '#fff', fontWeight: '800', fontSize: 15 },

  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingTop: 10,
    paddingBottom: 6,
    gap: 8,
    borderTopWidth: 1,
    borderTopColor: '#f3f4f6',
  },
  input: {
    flex: 1,
    backgroundColor: '#f9fafb',
    borderRadius: 22,
    paddingHorizontal: 16,
    paddingVertical: Platform.OS === 'ios' ? 11 : 8,
    fontSize: 14,
    color: '#111827',
    borderWidth: 1,
    borderColor: '#e5e7eb',
  },
  sendBtn: {
    width: 42, height: 42, borderRadius: 21,
    backgroundColor: GREEN,
    alignItems: 'center', justifyContent: 'center',
  },
  sendBtnOff: { backgroundColor: '#d1d5db' },
});
