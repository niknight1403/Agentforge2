import test from 'node:test';
import assert from 'node:assert/strict';
import { openHandsCanvasStatus } from '../openhands.mjs';

test('OpenHands Canvas bleibt optional und standardmäßig ausgeschaltet', () => {
  assert.deepEqual(openHandsCanvasStatus({}), {
    enabled: false,
    url: null,
    state: 'not_configured'
  });
});

test('OpenHands Canvas akzeptiert HTTP(S), entfernt Fragmente und liefert keine Zugangsdaten zurück', () => {
  assert.deepEqual(openHandsCanvasStatus({ OPENHANDS_CANVAS_URL: 'https://canvas.example.test/canvas#secret-fragment' }), {
    enabled: true,
    url: 'https://canvas.example.test/canvas',
    state: 'configured'
  });
});

test('OpenHands Canvas blockiert unsichere URL-Schemata und eingebettete Zugangsdaten', () => {
  for (const value of ['javascript:alert(1)', 'file:///etc/passwd', 'https://user:pass@example.test']) {
    assert.deepEqual(openHandsCanvasStatus({ OPENHANDS_CANVAS_URL: value }), {
      enabled: false,
      url: null,
      state: 'invalid_configuration'
    });
  }
});

test('OpenHands Canvas blockiert überlange URLs', () => {
  assert.equal(openHandsCanvasStatus({ OPENHANDS_CANVAS_URL: `https://canvas.example.test/${'a'.repeat(2048)}` }).state, 'invalid_configuration');
});
