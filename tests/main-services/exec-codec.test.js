'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { quotePosix, buildExecBootstrap, createExecParser } = require('../../electron/exec-codec');
const nonce = 'ab'.repeat(32);
const record = (name) => `\x1eUSSHTC_${nonce}:${name}\x1f`;
const frame = (output, code = 7) => record('READY') + record('START') + Buffer.concat([Buffer.from(output), Buffer.from(record(`END:${code}`))]).toString('base64');
function collector(options = {}) {
  const chunks = []; const events = []; let code = null;
  const parser = createExecParser({nonce,onReady:()=>events.push('ready'),onStart:()=>events.push('start'),onOutput:b=>chunks.push(Buffer.from(b)),onComplete:value=>{code=value;events.push('complete');},...options});
  return {parser,chunks,events,get code(){return code;}};
}

test('exec preserves every byte and exit code across every wire split', () => {
  for (const output of ['', 'x', '  x\t', '\n\nx\n\n', 'x\r\ny', '\x1b[31m中🙂é\x1b[0m', '\x1b]0;title\x07\0\x03', 'DONE_abcdef 0']) {
    const bytes=Buffer.from(output); const wire=frame(bytes);
    for(let split=0;split<=wire.length;split++) {
      const result=collector();result.parser.write(wire.slice(0,split));result.parser.write(wire.slice(split));result.parser.end();
      assert.deepEqual(Buffer.concat(result.chunks),bytes);
      assert.deepEqual(result.events,['ready','start','complete']);assert.equal(result.code,7);
    }
  }
});

test('record and base64 carry tolerate single-character delivery and CRLF line wraps', () => {
  const output=Buffer.from('中文🙂é\r\n');
  const wire=frame(output,255); const prefix=record('READY')+record('START');
  const wrapped=prefix+wire.slice(prefix.length).match(/.{1,4}/g).join('\r\n')+'\r\n';
  const result=collector();for(const character of wrapped)result.parser.write(character);
  result.parser.end();assert.deepEqual(Buffer.concat(result.chunks),output);assert.equal(result.code,255);
});

test('a different nonce is output, never an end record', () => {
  const output=Buffer.from('\x1eUSSHTC_'+ 'cd'.repeat(32)+':END:0\x1f');
  const result=collector();result.parser.write(frame(output,12));assert.deepEqual(Buffer.concat(result.chunks),output);assert.equal(result.code,12);
});

test('exact output limit passes and limit plus one fails without accepting excess bytes', () => {
  const exact=collector({maxOutputBytes:3});exact.parser.write(frame('abc',0));assert.equal(exact.code,0);
  const excess=collector({maxOutputBytes:3});assert.throws(()=>excess.parser.write(frame('abcd',0)),{code:'EXEC_OUTPUT_LIMIT'});assert.ok(Buffer.concat(excess.chunks).length<=3);
});

test('prelude and encoded floods are bounded, including whitespace-only encoding', () => {
  const prelude=collector({maxPreludeBytes:10});assert.throws(()=>prelude.parser.write('x'.repeat(200)),{code:'EXEC_OUTPUT_LIMIT'});
  const encoded=collector({maxEncodedBytes:8});encoded.parser.write(record('READY')+record('START'));assert.throws(()=>encoded.parser.write('\n'.repeat(9)),{code:'EXEC_OUTPUT_LIMIT'});
});

test('invalid codes, malformed alphabet, padding and incomplete streams fail closed', () => {
  for(const output of [frame('',256),frame('',-1),record('READY')+record('START')+'@@@@',record('READY')+record('START')+'AB==']) {
    const result=collector();assert.throws(()=>result.parser.write(output),{code:'EXEC_FRAMING_FAILED'});assert.equal(result.code,null);
  }
  const setup=collector();assert.throws(()=>setup.parser.end(),{code:'EXEC_SETUP_FAILED'});
  const truncated=collector();truncated.parser.write(record('READY')+record('START')+'YW');assert.throws(()=>truncated.parser.end(),{code:'EXEC_FRAMING_FAILED'});
});

test('POSIX quoting rejects NUL and bootstrap requires a full random nonce', () => {
  assert.throws(()=>quotePosix('a\0b'),{code:'EXEC_SETUP_FAILED'});
  assert.throws(()=>buildExecBootstrap('short'),{code:'EXEC_SETUP_FAILED'});
});
