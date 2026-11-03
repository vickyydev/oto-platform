import { describe, expect, it } from 'vitest';
import { trustedBoxBridgeOrigin } from '../src/box-bridge-origin';

describe('box credential destination', () => {
  it('requires a DNS child of the configured zone and keeps its exact origin', () => {
    expect(trustedBoxBridgeOrigin('https://zz-test.boxes.example.test:8443/', 'boxes.example.test')).toBe('https://zz-test.boxes.example.test:8443');
  });
  it.each(['https://evil.example', 'https://boxes.example.test.evil.test', 'https://evilboxes.example.test',
    'https://boxes.example.test', 'https://zz-test.boxes.example.test.', 'http://zz-test.boxes.example.test',
    'https://user@zz-test.boxes.example.test', 'https://zz-test.boxes.example.test/path',
    'https://zz-test.boxes.example.test?x=1', 'https://zz-test.boxes.example.test#x',
    'https://0.0.0.0', 'https://[::]', 'https://127.1', 'https://2130706433', 'https://0x7f000001',
    'https://[::ffff:127.0.0.1]', 'https://192.168.1.1', ' https://zz-test.boxes.example.test'])('refuses %s', value => {
    expect(trustedBoxBridgeOrigin(value, 'boxes.example.test', true)).toBeNull();
  });
  it.each(['', undefined, '*.example.test', '.example.test', 'https://example.test', '127.0.0.1'])('a missing or invalid zone never admits an address: %s', zone => {
    expect(trustedBoxBridgeOrigin('https://zz-test.boxes.example.test', zone, true)).toBeNull();
  });
  it('local proof still requires a DNS zone and explicit HTTP loopback permission, never an IP', () => {
    expect(trustedBoxBridgeOrigin('http://zz-test.localhost:8471', 'localhost', true)).toBe('http://zz-test.localhost:8471');
    expect(trustedBoxBridgeOrigin('http://zz-test.localhost:8471', 'localhost')).toBeNull();
    expect(trustedBoxBridgeOrigin('http://127.0.0.1:8471', 'localhost', true)).toBeNull();
    expect(trustedBoxBridgeOrigin('http://zz-test.localhost:8471', '', true)).toBeNull();
  });
});
