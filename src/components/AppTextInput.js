import React, { useRef } from 'react';
import { TextInput } from 'react-native';

export function AppTextInput({ onChangeText, value, ...props }) {
  const lastValueRef = useRef(value || '');

  const handleChange = (text) => {
    const prev = lastValueRef.current;
    if (prev.length > 0 && (text === prev + prev || text === prev + ' ' + prev)) return;
    lastValueRef.current = text;
    onChangeText?.(text);
  };

  React.useEffect(() => {
    if (value !== undefined) lastValueRef.current = value;
  }, [value]);

  return <TextInput {...props} value={value} onChangeText={handleChange} />;
}

export default AppTextInput;
