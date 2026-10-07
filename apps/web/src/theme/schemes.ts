export type SchemeId = 'deep-ocean' | 'night-harbor' | 'foggy-dusk' | 'cyan-tech' | 'indigo-shift';
export interface Scheme { id: SchemeId; label: string; }
export const SCHEMES: Scheme[] = [
  { id: 'deep-ocean', label: 'Deep Ocean' },
  { id: 'night-harbor', label: 'Night Harbor' },
  { id: 'foggy-dusk', label: 'Foggy Dusk' },
  { id: 'cyan-tech', label: 'Cyan Tech' },
  { id: 'indigo-shift', label: 'Indigo Shift' },
];
export const DEFAULT_SCHEME_ID: SchemeId = 'deep-ocean';
export const STORAGE_KEY = 'prismschism:theme';
export function isSchemeId(v: unknown): v is SchemeId {
  return typeof v === 'string' && SCHEMES.some((s) => s.id === v);
}
