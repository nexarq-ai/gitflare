import { describe, expect, it } from 'vitest';
import { labelColor, labelStyle, personLabel, reasonLabel, signInHref } from '../src/ui/PublicIssues';

describe('public issue presentation', () => {
  it('names people by handle, then name', () => {
    const people = { u1: { name: 'Ada Lovelace', handle: 'ada' }, u2: { name: 'Grace Hopper', handle: null } };
    expect(personLabel('u1', people)).toBe('@ada');
    expect(personLabel('u2', people)).toBe('Grace Hopper');
    expect(personLabel('gitflare', people)).toBe('Gitflare');
    expect(personLabel('u3', people)).toBe('Unknown');
    expect(personLabel('u1')).toBe('Unknown');
  });

  it('only tints labels with a valid hex color', () => {
    expect(labelColor('#D73A4A')).toBe('#d73a4a');
    for (const value of [undefined, '', 'red', '#fff', '#12345g', 'url(x)', '#d73a4a;color:red']) expect(labelColor(value), String(value)).toBe(null);
    expect(labelStyle('#0e8a16')).toEqual({ '--issue-label': '#0e8a16' });
    expect(labelStyle('javascript:alert(1)')).toBeUndefined();
  });

  it('labels moderation reasons', () => {
    expect(reasonLabel('too-heated')).toBe('Too heated');
    expect(reasonLabel('off-topic')).toBe('Off topic');
    expect(reasonLabel('spam')).toBe('Spam');
  });

  it('sends visitors to sign in, or to the app host when the site only has a hint', () => {
    const toApp = (path: string) => `https://app.example.com${path}`;
    expect(signInHref(false, '/acme/widgets/issues/3', toApp)).toBe('https://app.example.com/signin');
    expect(signInHref(true, '/acme/widgets/issues/3', toApp)).toBe('https://app.example.com/acme/widgets/issues/3');
  });
});
