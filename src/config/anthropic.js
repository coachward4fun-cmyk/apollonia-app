// Anthropic API config.
// Set EXPO_PUBLIC_ANTHROPIC_API_KEY in .env (and as an EAS secret for builds)
// to enable AI Assistant features. Defaults to an empty string so the bundle
// builds even when the key isn't set — calls to api.anthropic.com will 401 at
// runtime in that case.

export const ANTHROPIC_API_KEY = process.env.EXPO_PUBLIC_ANTHROPIC_API_KEY || '';

export const CLAUDE_MODEL = 'claude-sonnet-4-6';
