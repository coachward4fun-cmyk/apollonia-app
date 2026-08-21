import React, { useRef } from 'react';
import { TextInput } from 'react-native';

// Strip whitespace AND non-printable / special Unicode before comparing:
//   • C0 controls            U+0000–U+001F
//   • DEL + C1 controls      U+007F–U+009F
//   • zero-width / bidi marks U+200B–U+200F
//   • BOM                    U+FEFF
//   • Object Replacement     U+FFFC
//   • Replacement char       U+FFFD
// iOS dictation appends a hidden U+FFFC to `prev` just before firing the doubled
// event, so the raw strings never match. Normalizing both sides lets the doubling
// guard compare the real text. Implemented as a code-point filter rather than a
// regex literal so no control characters are embedded in source (a literal NUL or
// newline inside a /.../ would break the bundler).
const clean = (str) => {
  let out = '';
  for (const ch of str) {
    if (/\s/.test(ch)) continue;
    const c = ch.codePointAt(0);
    if (c <= 0x001f) continue;                  // C0 controls
    if (c >= 0x007f && c <= 0x009f) continue;   // DEL + C1 controls
    if (c >= 0x200b && c <= 0x200f) continue;   // zero-width + bidi
    if (c === 0xfeff || c === 0xfffc || c === 0xfffd) continue;
    out += ch;
  }
  return out;
};

const NUMERIC_KEYBOARD_TYPES = ['numeric', 'decimal-pad', 'number-pad', 'phone-pad'];

export function AppTextInput({ onChangeText, value, ...props }) {
  const lastValueRef = useRef(value || '');

  // Reset the guard baseline whenever the controlled value is cleared (e.g. after
  // submit). Replaces the old value-sync useEffect, which could race with rapid
  // dictation updates.
  if (value === '' && lastValueRef.current !== '') {
    lastValueRef.current = '';
  }

  const handleChange = (text) => {
    const prev = lastValueRef.current;

    // Dictation doesn't run on numeric keyboards, so the doubling guard is both
    // unnecessary there and actively harmful — it misfires on repeated-digit input
    // like "1" -> "11" or "22" -> "2222".
    const isNumericKeyboard = NUMERIC_KEYBOARD_TYPES.includes(props.keyboardType);

    if (!isNumericKeyboard && prev.length > 0) {
      const cleanText = clean(text);
      const cleanPrev = clean(prev);
      if (cleanPrev.length > 0 && cleanText === cleanPrev + cleanPrev) {
        return; // iOS dictation doubled text — drop it
      }
    }

    lastValueRef.current = text;
    onChangeText?.(text);
  };

  return <TextInput {...props} value={value} onChangeText={handleChange} />;
}

export default AppTextInput;
