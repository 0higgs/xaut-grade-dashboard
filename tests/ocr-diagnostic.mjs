import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { createWorker } from 'tesseract.js';
import { fileURLToPath } from 'node:url';

const ocrRoot = path.resolve(fileURLToPath(new URL('../public/ocr', import.meta.url)));
const sampleBase64 = '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';
const sample = process.env.CAPTCHA_SAMPLE || Buffer.from(sampleBase64, 'base64');
const expectedText = process.env.CAPTCHA_EXPECTED || 'c664';

const worker = await createWorker('eng', 1, {
  langPath: ocrRoot,
  corePath: path.join(ocrRoot, 'tesseract-core-lstm.wasm.js'),
  cachePath: path.join(os.tmpdir(), 'xaut-captcha-ocr-test'),
  gzip: true
});

try {
  await worker.setParameters({
    tessedit_pageseg_mode: '8',
    tessedit_char_whitelist: '0123456789abcdefghijklmnopqrstuvwxyz',
    user_defined_dpi: '300'
  });
  const recognition = await worker.recognize(sample);
  const text = String(recognition.data.text || '').toLowerCase().replace(/[^0-9a-z]/g, '').slice(0, 4);
  assert.equal(text, expectedText, `Expected ${expectedText}, recognized ${text || '(empty)'}`);
  console.log(`OCR diagnostic passed: recognized ${text} with the bundled local model`);
} finally {
  await worker.terminate();
}
