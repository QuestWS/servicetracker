import { describe, expect, it } from 'vitest';
import { isApple, smsDraftUrl, smsNumber } from '../assets/lib/sms.js';

describe('the text message draft', () => {
  it('dials a US number however it was typed', () => {
    expect(smsNumber('(815) 433-2200')).toBe('+18154332200');
    expect(smsNumber('1-815-433-2200')).toBe('+18154332200');
    expect(smsNumber('815.433.2200')).toBe('+18154332200');
  });

  it('leaves out a number that will not dial rather than guessing', () => {
    expect(smsNumber('')).toBe('');
    expect(smsNumber('433-2200')).toBe('');
    expect(smsNumber(null)).toBe('');
  });

  it('carries the whole message, line break included', () => {
    const url = smsDraftUrl('8154332200', 'Invoice 01-8891.\nPlease note: call (815) 433-2200 & ask', false);
    expect(url).toBe('sms:+18154332200?body=Invoice%2001-8891.%0APlease%20note%3A%20call%20(815)%20433-2200%20%26%20ask');
    expect(decodeURIComponent(url.split('body=')[1])).toContain('\nPlease note');
  });

  it("uses the separator each phone's Messages app reads", () => {
    expect(smsDraftUrl('8154332200', 'hi', true)).toBe('sms:+18154332200&body=hi');
    expect(smsDraftUrl('8154332200', 'hi', false)).toBe('sms:+18154332200?body=hi');
    expect(smsDraftUrl('', 'hi', false)).toBe('sms:?body=hi');
  });

  it('knows an Apple device, iPad included', () => {
    expect(isApple({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)' })).toBe(true);
    expect(isApple({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' })).toBe(true);
    expect(isApple({ userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 9)' })).toBe(false);
  });
});
