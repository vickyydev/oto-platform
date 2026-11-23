import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SerialPortMock } from 'serialport';
import { decodeDigioFrame, digioTerminal, encodeDigioFrame, encodeTlv, readTlv } from '../src/terminal/digio';
import { connectTerminalPort } from '../src/terminal/native-serial';
import { terminalChannel } from '../src/terminal/serial-channel';

test('the USB path sends a one-baht card sale and waits for its own approval', async () => {
  const path = '/dev/mock-pax';
  SerialPortMock.binding.createPort(path, { record: true });
  const port = new SerialPortMock({ path, baudRate: 9600, autoOpen: false });
  const ref = '123456';
  let sent: Buffer | undefined;
  const terminal = digioTerminal({
    deviceId: 'bench-digio', label: 'ZZ TEST PAX', terminalId: null, merchantId: null,
    nextRef: async () => ref, now: () => new Date(), timeouts: { saleMs: 1000 },
    open: async () => terminalChannel(await connectTerminalPort(port)),
  });
  const answer = await terminal.sale({
    attemptId: 'bench-sale', amountSatang: 100, tender: 'card',
    onProgress: event => {
      if (event.kind !== 'sent') return;
      const binding = port.port!;
      sent = Buffer.from(binding.recording);
      const response = (reference: string, amount: string) => encodeDigioFrame(encodeTlv([
        { tag: '21', value: 'A1' }, { tag: '22', value: '100' }, { tag: '04', value: reference },
        { tag: '01', value: amount }, { tag: '05', value: 'bankref' },
      ]));
      binding.emitData(Buffer.concat([response('654321', '500'), response(ref, '100')]));
    },
  });
  assert.ok(sent);
  const request = Object.fromEntries(readTlv(decodeDigioFrame(sent)).map(t => [t.tag, t.value]));
  assert.equal(request['21'], 'A0');
  assert.equal(request['05'], 'A1');
  assert.equal(request['01'], '100');
  assert.equal(answer.outcome, 'approved');
  assert.equal(answer.approvedSatang, 100);
  assert.equal(port.isOpen, false);
});
